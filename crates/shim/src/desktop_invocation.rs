//! A managed Desktop also passes its environment to native tool helpers. Their
//! private app-servers must not become another owner of the Host Runtime.

#[cfg(any(target_os = "macos", target_os = "windows", test))]
use codexhost_platform::ProcessSnapshot;
#[cfg(any(target_os = "macos", test))]
use std::{ffi::OsStr, ffi::OsString, path::Path};

pub(crate) fn is_desktop_helper(
    _stock_codex_path: &std::path::Path,
    _arguments: &[std::ffi::OsString],
) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Some(launcher_id) = std::env::var(super::LAUNCHER_PID_ENV)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|id| *id != 0)
        else {
            return false;
        };
        is_helper_descendant(std::process::id(), launcher_id, |id| {
            codexhost_platform::process_snapshot(id).ok()
        })
    }
    #[cfg(target_os = "macos")]
    {
        is_macos_desktop_helper(_stock_codex_path, _arguments).unwrap_or(false)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    false
}

#[cfg(target_os = "macos")]
fn is_macos_desktop_helper(stock_codex_path: &Path, arguments: &[OsString]) -> Option<bool> {
    use codexhost_platform::{discover_codex_desktop_from_root, process_snapshot};
    use std::path::PathBuf;

    let launcher_id = std::env::var(super::LAUNCHER_PID_ENV).ok()?.parse().ok()?;
    let launcher = process_snapshot(launcher_id).ok()?;
    let expected_launcher = PathBuf::from(std::env::var_os("CODEXHOST_LAUNCHER_EXECUTABLE")?)
        .canonicalize()
        .ok()?;
    if launcher.executable != expected_launcher {
        return None;
    }
    // LaunchServices reparents Desktop to launchd, so the launcher cannot be an
    // ancestor. Find the validated Desktop among the CLI's enclosing app bundles;
    // newer layouts nest the CLI in its own app. Direct Desktop -> shim stays Host.
    let installation = stock_codex_path
        .ancestors()
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
        .find_map(|bundle| {
            let installation = discover_codex_desktop_from_root(bundle).ok()?;
            (installation.executable_codex_cli == stock_codex_path).then_some(installation)
        })?;
    let originator = std::env::var_os(super::INTERNAL_ORIGINATOR_OVERRIDE_ENV);
    Some(is_macos_helper_descendant(
        std::process::id(),
        &installation.desktop_executable,
        &installation.install_root,
        launcher.started_at_micros,
        arguments,
        originator.as_deref(),
        |id| process_snapshot(id).ok(),
    ))
}

/// The Desktop local app-server's stdio builder adds the codex-app-tools override
/// after its base flags and other config overrides. The startup probe shares the
/// base flags, and plugin helpers can also run app-server over stdio.
#[cfg(any(target_os = "macos", test))]
fn has_local_app_server_signature(arguments: &[OsString]) -> bool {
    let [config, code_mode, subcommand, analytics, overrides @ ..] = arguments else {
        return false;
    };
    const APP_TOOLS: &str = "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=";
    config == "-c"
        && code_mode == "features.code_mode_host=true"
        && subcommand == "app-server"
        && analytics == "--analytics-default-enabled"
        && overrides.len().is_multiple_of(2)
        && overrides.chunks_exact(2).all(|pair| pair[0] == "-c")
        && matches!(
            overrides
                .last()
                .and_then(|value| value.to_str())
                .and_then(|value| value.strip_prefix(APP_TOOLS)),
            Some("true" | "false")
        )
}

#[cfg(any(target_os = "macos", test))]
fn is_macos_helper_descendant(
    shim_id: u32,
    desktop_executable: &Path,
    install_root: &Path,
    launcher_started_at_micros: u64,
    arguments: &[OsString],
    originator: Option<&OsStr>,
    mut inspect: impl FnMut(u32) -> Option<ProcessSnapshot>,
) -> bool {
    let marked = has_local_app_server_signature(arguments);
    let Some(mut child) = inspect(shim_id) else {
        return marked;
    };
    for depth in 1..=32 {
        if child.parent_id <= 1 || child.parent_id == child.id {
            break;
        }
        let Some(parent) = inspect(child.parent_id) else {
            break;
        };
        if parent.started_at_micros > child.started_at_micros {
            break; // Parent PID was reused.
        }
        if parent.executable == desktop_executable {
            if parent.started_at_micros < launcher_started_at_micros {
                break;
            }
            // Newer Desktop builds start the main app-server through a bundled utility.
            let main_through_utility = depth == 2
                && marked
                && originator == Some(OsStr::new(super::DESKTOP_ORIGINATOR))
                && child.executable.starts_with(install_root);
            return depth > 1 && !main_through_utility;
        }
        child = parent;
    }
    // A marked invocation must establish its Desktop ancestry before owning the Host.
    marked
}

#[cfg(any(target_os = "windows", test))]
fn is_helper_descendant(
    shim_id: u32,
    launcher_id: u32,
    mut inspect: impl FnMut(u32) -> Option<ProcessSnapshot>,
) -> bool {
    let Some(mut child) = inspect(shim_id) else {
        return false;
    };
    // Windows launch is launcher -> Desktop -> shim. Only a positively observed
    // deeper descendant is a helper; stale/missing launch metadata keeps the
    // existing explicit Host/remote invocation behavior. Bound ancestry work.
    for depth in 1..=32 {
        if child.parent_id == 0 || child.parent_id == child.id {
            return false;
        }
        let Some(parent) = inspect(child.parent_id) else {
            return false;
        };
        if parent.started_at_micros > child.started_at_micros {
            return false; // Parent PID was reused.
        }
        if parent.id == launcher_id {
            return depth > 2;
        }
        child = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: u32, parent_id: u32) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: 0,
            executable: std::path::PathBuf::from("fixture"),
            started_at_micros: u64::from(id),
        }
    }

    const BUNDLE: &str = "/Applications/ChatGPT.app";
    const DESKTOP: &str = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const UTILITY: &str = "/Applications/ChatGPT.app/Contents/Frameworks/Codex (Aperitif)";
    const MAIN_ARGS: &[&str] = &[
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--analytics-default-enabled",
        "-c",
        "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
    ];

    fn macos_helper(
        chain: &[(u32, u32, &str)],
        arguments: &[&str],
        originator: Option<&str>,
    ) -> bool {
        is_macos_helper_descendant(
            40,
            Path::new(DESKTOP),
            Path::new(BUNDLE),
            1,
            &arguments.iter().map(OsString::from).collect::<Vec<_>>(),
            originator.map(OsStr::new),
            |id| {
                let &(_, parent_id, executable) = chain.iter().find(|entry| entry.0 == id)?;
                Some(ProcessSnapshot {
                    executable: executable.into(),
                    ..snapshot(id, parent_id)
                })
            },
        )
    }

    #[test]
    fn macos_desktop_direct_app_server_remains_main() {
        assert!(!macos_helper(
            &[(40, 10, "/shim"), (10, 1, DESKTOP)],
            &["app-server"],
            None,
        ));
    }

    #[test]
    fn macos_local_app_server_through_bundled_utility_is_main() {
        let chain = [(40, 20, "/shim"), (20, 10, UTILITY), (10, 1, DESKTOP)];
        assert!(!macos_helper(&chain, MAIN_ARGS, Some("Codex Desktop")));
        let mut disabled = MAIN_ARGS.to_vec();
        *disabled.last_mut().unwrap() =
            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false";
        assert!(!macos_helper(&chain, &disabled, Some("Codex Desktop")));
    }

    #[test]
    fn macos_browser_and_computer_use_app_servers_remain_helpers() {
        let chain = [(40, 20, "/shim"), (20, 10, UTILITY), (10, 1, DESKTOP)];
        assert!(macos_helper(
            &chain,
            &["app-server", "--listen", "stdio://"],
            None
        ));
        assert!(macos_helper(&chain, MAIN_ARGS, Some("codex_computer_use")));
        assert!(macos_helper(&chain, MAIN_ARGS, None));
        assert!(macos_helper(&chain, &MAIN_ARGS[..4], Some("Codex Desktop")));
    }

    #[test]
    fn macos_main_app_server_args_do_not_authorize_an_unverified_chain() {
        for chain in [
            &[
                (40, 20, "/shim"),
                (20, 10, "/other.app/utility"),
                (10, 1, DESKTOP),
            ][..],
            &[(40, 20, "/shim"), (20, 10, UTILITY)][..],
            &[
                (40, 20, "/shim"),
                (20, 10, UTILITY),
                (10, 1, "/other.app/main"),
            ][..],
            &[(40, 20, "/shim"), (20, 70, UTILITY), (70, 1, DESKTOP)][..],
            &[
                (40, 20, "/shim"),
                (20, 15, UTILITY),
                (15, 10, UTILITY),
                (10, 1, DESKTOP),
            ][..],
        ] {
            assert!(macos_helper(chain, MAIN_ARGS, Some("Codex Desktop")));
        }
    }

    #[test]
    fn distinguishes_desktop_from_nested_helpers() {
        let inspect = |id| (id >= 1).then(|| snapshot(id, id - 1));
        assert!(!is_helper_descendant(3, 1, inspect));
        assert!(is_helper_descendant(4, 1, inspect));
        assert!(is_helper_descendant(5, 1, inspect));
        assert!(!is_helper_descendant(3, 99, inspect));
    }

    #[test]
    fn rejects_missing_reused_and_unbounded_ancestry() {
        assert!(!is_helper_descendant(4, 1, |_| None));
        assert!(!is_helper_descendant(4, 1, |id| {
            let mut value = snapshot(id, id - 1);
            if id == 2 {
                value.started_at_micros = 99;
            }
            Some(value)
        }));
        assert!(!is_helper_descendant(4, 1, |id| Some(snapshot(id, id))));
        let mut calls = 0;
        assert!(!is_helper_descendant(100, 1, |id| {
            calls += 1;
            Some(snapshot(id, id - 1))
        }));
        assert_eq!(calls, 33);
    }
}
