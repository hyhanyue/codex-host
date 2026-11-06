import type { ArtifactSource } from "./artifact.js";
import { requireSemanticVersion } from "./status.js";

const REPOSITORY = "hyhanyue/codex-host";
const UPDATE_BRANCH = "codexhost-code-changes";
const RELEASES_ENDPOINT = `repos/${REPOSITORY}/releases`;
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const DOWNLOAD_URL_PREFIX = `${RELEASES_URL}/download/`;
const STABLE_TAG_PATTERN =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;

export const GITHUB_API_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "codexhost-updater",
  "x-github-api-version": "2022-11-28",
};

export type InstallerReleaseTarget = "macos-arm64" | "macos-x64" | "windows-x64" | "windows-arm64";
export type ReleaseTarget = InstallerReleaseTarget | "linux-x64" | "linux-arm64";

export interface CodexhostLatestRelease {
  version: string;
  releaseNotes: string | null;
  releaseNotesUrl: string;
  assets: readonly CodexhostReleaseAsset[];
}

export interface CodexhostReleaseAsset {
  name: string;
  size: number;
  digest: string | null;
  downloadUrl: string;
}

export interface SelectedReleaseArtifact {
  name: string;
  source: ArtifactSource;
}

export interface GitHubReleaseFetchOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function releaseAsset(value: unknown): CodexhostReleaseAsset {
  const asset = record(value, "GitHub Release asset");
  if (
    typeof asset.name !== "string" ||
    asset.name.length === 0 ||
    asset.name.length > 160 ||
    !Number.isSafeInteger(asset.size) ||
    (asset.size as number) <= 0 ||
    (asset.size as number) > 2 * 1024 * 1024 * 1024 ||
    (asset.digest != null && typeof asset.digest !== "string") ||
    typeof asset.browser_download_url !== "string" ||
    !asset.browser_download_url.startsWith(DOWNLOAD_URL_PREFIX)
  ) {
    throw new Error("GitHub Release asset is invalid");
  }
  const url = new URL(asset.browser_download_url);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("GitHub Release asset URL is invalid");
  }
  return {
    name: asset.name,
    size: asset.size as number,
    digest: typeof asset.digest === "string" ? asset.digest : null,
    downloadUrl: asset.browser_download_url,
  };
}

export function parseLatestGitHubRelease(value: unknown): CodexhostLatestRelease {
  const release = record(value, "GitHub latest Release");
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string" ||
    !STABLE_TAG_PATTERN.test(release.tag_name) ||
    typeof release.html_url !== "string" ||
    (release.body != null && typeof release.body !== "string") ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("GitHub latest Release is invalid");
  }
  const version = requireSemanticVersion(release.tag_name.slice(1));
  if (release.html_url !== `${RELEASES_URL}/tag/${release.tag_name}`) {
    throw new Error("GitHub Release notes URL does not match its tag");
  }
  const releaseNotes =
    typeof release.body === "string" && release.body.trim().length > 0
      ? release.body.slice(0, 20_000)
      : null;
  return Object.freeze({
    version,
    releaseNotes,
    releaseNotesUrl: release.html_url,
    assets: Object.freeze(release.assets.map(releaseAsset)),
  });
}

type GitHubApiGet = (endpoint: string, allowMissing?: boolean) => Promise<unknown>;

function gitObject(value: unknown): { sha: string; type: string } {
  const object = record(record(value, "GitHub Git reference").object, "GitHub Git object");
  if (
    typeof object.sha !== "string" ||
    !COMMIT_SHA_PATTERN.test(object.sha) ||
    typeof object.type !== "string"
  ) {
    throw new Error("GitHub Git object is invalid");
  }
  return { sha: object.sha, type: object.type };
}

async function releaseCommit(get: GitHubApiGet, tag: string): Promise<string | null> {
  const ref = await get(`repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`, true);
  if (ref === null) return null;
  let object = gitObject(ref);
  const visited = new Set<string>();
  while (object.type === "tag") {
    if (visited.has(object.sha)) throw new Error("GitHub returned a cyclic tag");
    visited.add(object.sha);
    const annotatedTag = await get(`repos/${REPOSITORY}/git/tags/${object.sha}`, true);
    if (annotatedTag === null) return null;
    object = gitObject(annotatedTag);
  }
  return object.type === "commit" ? object.sha : null;
}

/** Select by version among published releases whose Git tag is on the update branch. */
export async function findLatestGitHubRelease(
  get: GitHubApiGet,
): Promise<CodexhostLatestRelease | null> {
  const pageSize = 100;
  const candidates: Record<string, unknown>[] = [];
  for (let page = 1; ; page += 1) {
    const releases = await get(`${RELEASES_ENDPOINT}?per_page=${pageSize}&page=${page}`);
    if (!Array.isArray(releases)) throw new Error("GitHub Releases response must be an array");
    for (const item of releases) {
      const release = record(item, "GitHub Release");
      if (
        release.draft === false &&
        release.prerelease === false &&
        typeof release.tag_name === "string" &&
        STABLE_TAG_PATTERN.test(release.tag_name)
      ) {
        candidates.push(release);
      }
    }
    if (releases.length < pageSize) break;
  }
  if (candidates.length === 0) return null;
  const version = (release: Record<string, unknown>): string =>
    (release.tag_name as string).slice(1);
  candidates.sort((left, right) => compareSemanticVersions(version(right), version(left)));
  const head = gitObject(await get(`repos/${REPOSITORY}/git/ref/heads/${UPDATE_BRANCH}`));
  if (head.type !== "commit") throw new Error("GitHub update branch must point to a commit");
  for (const candidate of candidates) {
    const commit = await releaseCommit(get, candidate.tag_name as string);
    if (commit === null) continue;
    if (commit === head.sha) return parseLatestGitHubRelease(candidate);
    const comparison = await get(
      `repos/${REPOSITORY}/compare/${commit}...${head.sha}?per_page=1`,
      true,
    );
    if (comparison === null) continue;
    // Pin both refs by SHA and check the merge base, not the Release's target_commitish.
    const result = record(comparison, "GitHub commit comparison");
    if (
      (result.status === "ahead" || result.status === "identical") &&
      record(result.merge_base_commit, "GitHub merge base").sha === commit
    ) {
      return parseLatestGitHubRelease(candidate);
    }
  }
  return null;
}

export async function fetchLatestGitHubRelease(
  options: GitHubReleaseFetchOptions = {},
): Promise<CodexhostLatestRelease | null> {
  const fetchImpl = options.fetch ?? fetch;
  return findLatestGitHubRelease(async (endpoint, allowMissing) => {
    const response = await fetchImpl(`https://api.github.com/${endpoint}`, {
      headers: GITHUB_API_HEADERS,
      redirect: "error",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub Release request failed with HTTP ${response.status}`);
    return response.json();
  });
}

function numericIdentifiers(value: string): [number, number, number] {
  const core = value.split(/[+-]/u, 1)[0] ?? "";
  const parts = core.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareSemanticVersions(leftValue: string, rightValue: string): number {
  const left = requireSemanticVersion(leftValue);
  const right = requireSemanticVersion(rightValue);
  const leftNumbers = numericIdentifiers(left);
  const rightNumbers = numericIdentifiers(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftNumbers[index] ?? 0) - (rightNumbers[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  const prerelease = (version: string): string | undefined => /^[^+-]+-([^+]+)/u.exec(version)?.[1];
  const leftPrerelease = prerelease(left);
  const rightPrerelease = prerelease(right);
  if (leftPrerelease === rightPrerelease) return 0;
  if (leftPrerelease === undefined) return 1;
  if (rightPrerelease === undefined) return -1;
  const leftParts = leftPrerelease.split(".");
  const rightParts = rightPrerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function expectedInstallerAssetName(
  version: string,
  target: InstallerReleaseTarget,
): string {
  requireSemanticVersion(version);
  const extension = target.startsWith("macos-") ? "dmg" : "exe";
  return `codexhost-${version}-${target}.${extension}`;
}

function selectReleaseArtifact(
  release: CodexhostLatestRelease,
  name: string,
): SelectedReleaseArtifact {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw new Error(`GitHub Release must contain exactly one ${name}`);
  const asset = matches[0];
  if (!asset) throw new Error(`GitHub Release must contain exactly one ${name}`);
  const digest = asset.digest === null ? null : SHA256_DIGEST_PATTERN.exec(asset.digest);
  const sha256 = digest?.[1];
  if (!sha256) throw new Error(`GitHub Release asset ${name} has no valid SHA-256 digest`);
  if (asset.downloadUrl !== `${DOWNLOAD_URL_PREFIX}v${release.version}/${name}`) {
    throw new Error(`GitHub Release asset ${name} has an unexpected download URL`);
  }
  return Object.freeze({
    name,
    source: Object.freeze({ url: asset.downloadUrl, sha256, size: asset.size }),
  });
}

export function selectInstallerReleaseArtifact(
  release: CodexhostLatestRelease,
  target: InstallerReleaseTarget,
): SelectedReleaseArtifact {
  return selectReleaseArtifact(release, expectedInstallerAssetName(release.version, target));
}

export function selectNpmReleaseArtifacts(
  release: CodexhostLatestRelease,
  target: ReleaseTarget,
): { metaArtifact: ArtifactSource; platformArtifact: ArtifactSource } {
  const base = `codexhost-cli-${release.version}`;
  return {
    metaArtifact: selectReleaseArtifact(release, `${base}.tgz`).source,
    platformArtifact: selectReleaseArtifact(release, `${base}-${target}.tgz`).source,
  };
}
