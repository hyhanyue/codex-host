# github-release-background-update Specification

## Purpose
Describe how the fork discovers, verifies, prepares, and installs updates.
## Requirements
### Requirement: Host discovers one stable GitHub Release
The update capability SHALL use only published GitHub Releases from `hyhanyue/codex-host` with stable `v<semver>` tags that resolve to commits in the history of `codexhost-code-changes`. It SHALL select the highest eligible SemVer and compare it with the packaged version. It SHALL verify the actual Git tag and branch ancestry independently of the Release’s target metadata. An empty list or a list with no eligible Release SHALL be a successful check with no update. Branch commits and Git tags without a Release do not advertise updates. Checking SHALL remain non-blocking and work without a login or embedded GitHub credential.

#### Scenario: New stable Release exists
- **WHEN** GitHub returns a non-draft, non-prerelease Release with a valid newer `v<semver>` tag
- **THEN** Host SHALL report the current version, latest version, update availability, bounded plain-text GitHub Release body, and release-notes URL

#### Scenario: GitHub is unavailable
- **WHEN** an automatic update check times out, is rate-limited, or returns malformed data
- **THEN** codexhost SHALL continue its normal managed Desktop behavior and expose a bounded retryable check failure

### Requirement: Host selects only the packaged target asset
Host SHALL derive the expected installer asset name from the packaged distribution target and the discovered version. It SHALL accept only that exact Release asset's HTTPS download URL, positive bounded size, and lowercase GitHub `sha256:` digest as installation input. Renderer MUST NOT provide or override a URL, digest, path, package, target, or version.

#### Scenario: Matching asset is complete
- **WHEN** the current installer target is `windows-x64` and the Release contains exactly one valid `codexhost-<version>-windows-x64.exe` asset
- **THEN** Host SHALL prepare that asset using its GitHub size and SHA-256 digest

#### Scenario: Asset digest is unavailable
- **WHEN** the matching Release asset has no valid SHA-256 digest
- **THEN** Host SHALL report the Release as visible but automatic installation unavailable and SHALL NOT download or execute the asset

#### Scenario: Renderer supplies privileged update input
- **WHEN** a fixed update operation includes an undeclared URL, digest, path, target, package, command, or version
- **THEN** the control boundary SHALL reject the request before Update Manager consumes it

### Requirement: Installed distribution determines update execution
The update capability SHALL read strict packaged distribution metadata and resolve the current npm, Windows installer, or macOS installer layout before preparation. It SHALL reject a target or distribution mismatch and SHALL use only absolute verified runtime paths derived from the installed package and Launcher-supplied identity.

#### Scenario: npm distribution starts an update
- **WHEN** packaged metadata identifies npm and the fixed npm runtime paths are available
- **THEN** Host SHALL require `codexhost-cli-<version>.tgz` and `codexhost-cli-<version>-<target>.tgz` from the eligible Fork Release. Both assets need an exact download URL, positive size, and SHA-256 digest. If either asset is unavailable, the Release remains visible and installation is disabled. The native helper SHALL recheck both digests and install the local tarballs together with npm in offline mode.

#### Scenario: Installer metadata does not match host target
- **WHEN** packaged metadata declares a target different from the running platform and architecture
- **THEN** automatic update SHALL fail before download or process shutdown

### Requirement: Installer preparation reports bounded download progress
The Host and Update Manager SHALL persist a `downloading` status for installer artifacts with nonnegative `downloadedBytes` and a positive `totalBytes` derived from the verified GitHub asset size. Renderer SHALL be able to read that status while preparation is active. Download completion SHALL be followed by the existing size and SHA-256 verification before the operation becomes `prepared` and before the Launcher stops the managed Desktop. For npm, download progress combines both tarballs, and both must be verified before handoff.

#### Scenario: macOS DMG download is active
- **WHEN** a verified macOS Release asset is being downloaded
- **THEN** status SHALL expose bounded downloaded and total byte counts
- **AND** the fixed status operation SHALL remain responsive
- **AND** the managed Desktop SHALL remain running until download and verification finish

#### Scenario: Installer download fails
- **WHEN** artifact download, size validation, or digest validation fails
- **THEN** status SHALL become `failed` with bounded error text
- **AND** the temporary artifact SHALL be removed
- **AND** the Launcher SHALL NOT stop the managed Desktop for that failed operation

### Requirement: Update starts once and stops the managed Desktop process tree
Host SHALL serialize update starts across current Host processes. After successful preparation it SHALL respond to the initiating Renderer. On Windows it SHALL start the temporary Updater; on macOS the Launcher SHALL start that helper from the prepared request. The Launcher SHALL then stop the owned Desktop process tree without invoking Electron `app.quit()`. The helper SHALL install only after the exact Launcher exits.

#### Scenario: User starts the current candidate
- **WHEN** no update operation is active and the current candidate remains the latest stable Release
- **THEN** exactly one helper SHALL start and the Launcher SHALL stop the owned Desktop process tree after that helper is waiting for exit

#### Scenario: User clicks update repeatedly
- **WHEN** a prepared or active operation already exists
- **THEN** Host SHALL return its bounded current status and SHALL NOT prepare another artifact or start another helper

#### Scenario: Launcher does not exit
- **WHEN** the managed Launcher remains alive past the Updater wait timeout
- **THEN** the helper SHALL record failure and SHALL NOT modify the installed distribution

### Requirement: Update status survives restart
The update capability SHALL store strict local operation status outside the installation root, discover the newest valid operation after relaunch, and expose only version, installation kind, phase, update time, and bounded error. It SHALL treat a freshly observed `restarting` phase as pending and SHALL clean stale terminal work without deleting active work.

#### Scenario: Updated application relaunches
- **WHEN** the new application starts while the helper status is `restarting` or `succeeded`
- **THEN** Host SHALL expose that operation until it reaches a terminal phase and Renderer SHALL be able to report the final result

#### Scenario: Prior update failed
- **WHEN** the latest valid operation contains a failed terminal status
- **THEN** Host SHALL return its bounded error and allow a later explicit retry

### Requirement: Release installation remains platform-specific
The existing background manager and native helper SHALL continue to use offline installation of the two verified npm tarballs, per-user silent Inno Setup, and same-filesystem macOS App replacement with installed distribution verification and relaunch. Permission or platform-policy failure SHALL be reported without automatic elevation.

#### Scenario: macOS parent directory is not writable
- **WHEN** the Updater cannot stage or replace the App in its current parent directory
- **THEN** it SHALL preserve or restore the prior App and record a permission failure without invoking hidden privilege escalation

### Requirement: ARM64 Linux npm distributions SHALL use npm updates
Strict distribution metadata SHALL accept `linux-arm64`, SHALL require it to match a running `linux/arm64` host, and SHALL resolve its installed update context through the existing npm update path. It MUST NOT select or require a GitHub Release installer asset for Linux.

#### Scenario: ARM64 Linux npm installation checks for updates
- **WHEN** packaged metadata identifies distribution `npm` and target `linux-arm64` on a `linux/arm64` host
- **THEN** Host resolves the verified npm package paths and reports npm installation availability
- **AND** update preparation uses offline installation of the two verified npm tarballs
- **AND** no DMG, EXE, `.deb`, or `.rpm` installer asset is selected

