import { describe, expect, it, vi } from "vitest";

import {
  compareSemanticVersions,
  expectedInstallerAssetName,
  fetchLatestGitHubRelease,
  fetchLatestGitHubReleaseWithGitHubCli,
  parseLatestGitHubRelease,
  selectInstallerReleaseArtifact,
  selectNpmReleaseArtifacts,
  type GitHubCliRunner,
} from "@codexhost/update-manager";

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.2.3",
    html_url: "https://github.com/hyhanyue/codex-host/releases/tag/v1.2.3",
    draft: false,
    prerelease: false,
    body: "## Changes\n\n- Safer updates",
    assets: [
      {
        name: "codexhost-1.2.3-windows-x64.exe",
        size: 42,
        digest: `sha256:${"ab".repeat(32)}`,
        browser_download_url:
          "https://github.com/hyhanyue/codex-host/releases/download/v1.2.3/codexhost-1.2.3-windows-x64.exe",
        uploader: { login: "github-actions" },
      },
    ],
    author: { login: "github-actions" },
    ...overrides,
  };
}

const repo = "repos/hyhanyue/codex-host";
const head = "a".repeat(40);
const cliResponse = (endpoint: string | undefined): string =>
  JSON.stringify(
    endpoint?.includes("/releases?") ? [release()] : { object: { type: "commit", sha: head } },
  );

describe("GitHub Release update discovery", () => {
  it("parses the public latest response and selects one exact target asset", () => {
    const parsed = parseLatestGitHubRelease(release());
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.releaseNotes).toBe("## Changes\n\n- Safer updates");
    expect(selectInstallerReleaseArtifact(parsed, "windows-x64")).toEqual({
      name: "codexhost-1.2.3-windows-x64.exe",
      source: {
        url: "https://github.com/hyhanyue/codex-host/releases/download/v1.2.3/codexhost-1.2.3-windows-x64.exe",
        sha256: "ab".repeat(32),
        size: 42,
      },
    });
    expect(expectedInstallerAssetName("1.2.3", "macos-arm64")).toBe(
      "codexhost-1.2.3-macos-arm64.dmg",
    );
  });

  it("rejects prereleases, mismatched notes, duplicate assets, and unverified selection", () => {
    expect(() => parseLatestGitHubRelease(release({ prerelease: true }))).toThrow("invalid");
    expect(() =>
      parseLatestGitHubRelease(
        release({
          html_url: "https://github.com/hyhanyue/codex-host/releases/tag/v9.9.9",
        }),
      ),
    ).toThrow("does not match");
    const parsedWithoutDigest = parseLatestGitHubRelease(
      release({
        assets: [
          {
            name: "codexhost-1.2.3-windows-x64.exe",
            size: 42,
            browser_download_url:
              "https://github.com/hyhanyue/codex-host/releases/download/v1.2.3/codexhost-1.2.3-windows-x64.exe",
          },
        ],
      }),
    );
    expect(parsedWithoutDigest.assets[0]?.digest).toBeNull();
    expect(() => selectInstallerReleaseArtifact(parsedWithoutDigest, "windows-x64")).toThrow(
      "no valid SHA-256",
    );
    const parsed = parseLatestGitHubRelease(release());
    expect(() =>
      selectInstallerReleaseArtifact(
        { ...parsed, assets: [...parsed.assets, ...parsed.assets] },
        "windows-x64",
      ),
    ).toThrow("exactly one");
    expect(() =>
      selectInstallerReleaseArtifact(
        { ...parsed, assets: parsed.assets.map((asset) => ({ ...asset, digest: null })) },
        "windows-x64",
      ),
    ).toThrow("no valid SHA-256");
  });

  it("uses stable SemVer precedence", () => {
    expect(compareSemanticVersions("1.2.3-test.2", "1.2.3")).toBeLessThan(0);
    expect(compareSemanticVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemanticVersions("1.2.3+one", "1.2.3+two")).toBe(0);
  });

  it("treats an empty Fork Release list as no update without looking at branch commits", async () => {
    const fetchImpl = vi.fn(async () => Response.json([]));
    await expect(fetchLatestGitHubRelease({ fetch: fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `https://api.github.com/${repo}/releases?per_page=100&page=1`,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("ignores other branches, drafts and previews and resolves an annotated ancestor tag", async () => {
    const offBranch = "b".repeat(40);
    const ancestor = "c".repeat(40);
    const annotatedTag = "d".repeat(40);
    const gitObject = (type: string, sha: string) => ({ object: { type, sha } });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input).replace("https://api.github.com/", "");
      const values: Record<string, unknown> = {
        [`${repo}/releases?per_page=100&page=1`]: [
          release({ tag_name: "v9.0.0", draft: true }),
          release({ tag_name: "v8.0.0", prerelease: true }),
          release({ tag_name: "v7.0.0-rc.1" }),
          release({ tag_name: "v6.0.0", target_commitish: "codexhost-code-changes" }),
          release({ target_commitish: "main" }),
        ],
        [`${repo}/git/ref/heads/codexhost-code-changes`]: gitObject("commit", head),
        [`${repo}/git/ref/tags/v6.0.0`]: gitObject("commit", offBranch),
        [`${repo}/compare/${offBranch}...${head}?per_page=1`]: {
          status: "diverged",
          merge_base_commit: { sha: ancestor },
        },
        [`${repo}/git/ref/tags/v1.2.3`]: gitObject("tag", annotatedTag),
        [`${repo}/git/tags/${annotatedTag}`]: gitObject("commit", ancestor),
        [`${repo}/compare/${ancestor}...${head}?per_page=1`]: {
          status: "ahead",
          merge_base_commit: { sha: ancestor },
        },
      };
      if (!(url in values)) throw new Error(`Unexpected request ${url}`);
      return Response.json(values[url]);
    });
    await expect(fetchLatestGitHubRelease({ fetch: fetchImpl })).resolves.toMatchObject({
      version: "1.2.3",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("requires both Fork npm assets with exact names, URLs and SHA-256 digests", () => {
    const npmAsset = (name: string) => ({
      name,
      size: 42,
      digest: `sha256:${"ab".repeat(32)}`,
      browser_download_url: `https://github.com/hyhanyue/codex-host/releases/download/v1.2.3/${name}`,
    });
    const meta = npmAsset("codexhost-cli-1.2.3.tgz");
    const platform = npmAsset("codexhost-cli-1.2.3-macos-arm64.tgz");
    const parsed = parseLatestGitHubRelease(release({ assets: [meta, platform] }));
    expect(selectNpmReleaseArtifacts(parsed, "macos-arm64")).toMatchObject({
      metaArtifact: { url: meta.browser_download_url, size: 42 },
      platformArtifact: { url: platform.browser_download_url, size: 42 },
    });
    expect(() => selectNpmReleaseArtifacts(parsed, "macos-x64")).toThrow("exactly one");
    const upstream = {
      ...platform,
      browser_download_url: platform.browser_download_url.replace("hyhanyue", "BytePioneer-AI"),
    };
    expect(() => parseLatestGitHubRelease(release({ assets: [meta, upstream] }))).toThrow(
      "invalid",
    );
  });

  it("uses the authenticated GitHub CLI without exposing its token", async () => {
    const run = vi.fn<GitHubCliRunner>(async (_executable, args) => cliResponse(args.at(-1)));
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { PATH: "/usr/bin:/bin" },
        executableCandidates: ["/opt/homebrew/bin/gh"],
        run,
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(run).toHaveBeenCalledWith(
      "/opt/homebrew/bin/gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        `${repo}/releases?per_page=100&page=1`,
      ],
      { environment: { PATH: "/usr/bin:/bin" } },
    );
  });

  it("falls back cleanly when GitHub CLI is unavailable", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        executableCandidates: ["gh", "/opt/homebrew/bin/gh"],
        run,
      }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("finds Homebrew gh with the minimal macOS GUI PATH", async () => {
    const run = vi.fn<GitHubCliRunner>(async (executable, args) => {
      if (executable === "gh") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return cliResponse(args.at(-1));
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        run,
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(run.mock.calls.map(([executable]) => executable)).toEqual([
      "gh",
      "/opt/homebrew/bin/gh",
      "/opt/homebrew/bin/gh",
      "/opt/homebrew/bin/gh",
    ]);
  });

  it.each(["win32", "linux"] as const)("discovers native gh on %s", async (platform) => {
    const expected =
      platform === "win32" ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "/usr/local/bin/gh";
    const run = vi.fn<GitHubCliRunner>(async (executable, args) => {
      if (executable !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return cliResponse(args.at(-1));
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { ProgramFiles: "C:\\Program Files" },
        platform,
        run,
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(run.mock.calls.at(-1)?.[0]).toBe(expected);
  });

  it("does not substitute another installation for an explicit gh command", async () => {
    const run = vi.fn<GitHubCliRunner>(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { CODEXHOST_GH_COMMAND: "/custom/gh" },
        run,
      }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("/custom/gh");
  });

  it("does not repeat CLI failures or expose their diagnostics", async () => {
    const run = vi.fn(async () => {
      throw new Error("private CLI diagnostic");
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        executableCandidates: ["gh", "/opt/homebrew/bin/gh"],
        run,
      }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    "not JSON",
    JSON.stringify(release({ prerelease: true })),
    JSON.stringify(release({ html_url: "https://example.com/release" })),
  ])("rejects invalid CLI release output", async (output) => {
    const run = vi.fn(async () => output);
    await expect(fetchLatestGitHubReleaseWithGitHubCli({ run })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not start gh after cancellation", async () => {
    const run = vi.fn();
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({ signal: AbortSignal.abort(), run }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates cancellation without exposing subprocess stderr", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      throw new Error("sensitive subprocess stderr");
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({ signal: controller.signal, run }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledOnce();
  });
});
