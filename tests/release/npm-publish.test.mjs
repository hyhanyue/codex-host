import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createNpmPublishPlan,
  parseNpmPublishArguments,
} from "../../scripts/release/publish-npm.mjs";

describe("npm registry publishing", () => {
  it("parses an explicit safe publishing request", () => {
    expect(
      parseNpmPublishArguments([
        "--artifacts",
        "/artifacts",
        "--version",
        "0.1.0-test.1",
        "--tag",
        "test",
        "--dry-run",
        "--provenance",
      ]),
    ).toEqual({
      artifactsRoot: "/artifacts",
      dryRun: true,
      provenance: true,
      registry: undefined,
      targets: undefined,
      tag: "test",
      version: "0.1.0-test.1",
    });
  });

  it("publishes all platform packages before the meta package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-publish-"));
    const version = "0.1.0-test.1";
    const names = [
      `codexhost-cli-${version}-macos-arm64.tgz`,
      `codexhost-cli-${version}-macos-x64.tgz`,
      `codexhost-cli-${version}-windows-x64.tgz`,
      `codexhost-cli-${version}-windows-arm64.tgz`,
      `codexhost-cli-${version}-linux-x64.tgz`,
      `codexhost-cli-${version}-linux-arm64.tgz`,
      `codexhost-cli-${version}.tgz`,
    ];
    try {
      await mkdir(path.join(root, "nested"));
      for (const name of names) await writeFile(path.join(root, "nested", name), name);
      const plan = await createNpmPublishPlan({ artifactsRoot: root, version });
      expect(plan.map((entry) => entry.packageName)).toEqual([
        "@codexhost/cli-darwin-arm64",
        "@codexhost/cli-darwin-x64",
        "@codexhost/cli-win32-x64",
        "@codexhost/cli-win32-arm64",
        "@codexhost/cli-linux-x64",
        "@codexhost/cli-linux-arm64",
        "@codexhost/cli",
      ]);
      expect(plan.at(-1).kind).toBe("meta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires exactly the explicitly selected macOS artifacts before publishing meta", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-publish-"));
    const version = "0.1.0-test.1";
    const targets = ["macos-arm64", "macos-x64"];
    const names = targets.map((target) => `codexhost-cli-${version}-${target}.tgz`);
    names.push(`codexhost-cli-${version}.tgz`);
    const options = { artifactsRoot: root, version, targets };
    try {
      for (const name of names) await writeFile(path.join(root, name), name);
      expect((await createNpmPublishPlan(options)).map((entry) => entry.packageName)).toEqual([
        "@codexhost/cli-darwin-arm64",
        "@codexhost/cli-darwin-x64",
        "@codexhost/cli",
      ]);
      const extra = path.join(root, `codexhost-cli-${version}-windows-x64.tgz`);
      await writeFile(extra, "unexpected");
      await expect(createNpmPublishPlan(options)).rejects.toThrow("unexpected npm release tarball");
      await rm(extra);
      await mkdir(path.join(root, "duplicate"));
      const duplicate = path.join(root, "duplicate", names[0]);
      await writeFile(duplicate, "duplicate");
      await expect(createNpmPublishPlan(options)).rejects.toThrow("duplicate npm release tarball");
      await rm(duplicate);
      for (const name of names) {
        await rm(path.join(root, name));
        await expect(createNpmPublishPlan(options)).rejects.toThrow("missing npm release tarball");
        await writeFile(path.join(root, name), name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses explicit release targets and rejects invalid or duplicate selections", () => {
    const base = ["--artifacts", "/artifacts", "--version", "0.1.0"];
    for (const args of [
      ["--targets", "macos-arm64,macos-x64"],
      ["--targets=macos-arm64,macos-x64"],
    ]) {
      expect(parseNpmPublishArguments([...base, ...args]).targets).toEqual([
        "macos-arm64",
        "macos-x64",
      ]);
    }
    for (const targets of ["", "macos-arm64,", "unknown", "macos-arm64,macos-arm64"]) {
      expect(() => parseNpmPublishArguments([...base, `--targets=${targets}`])).toThrow();
    }
    expect(() => parseNpmPublishArguments([...base, "--targets"])).toThrow("requires a value");
    expect(() => parseNpmPublishArguments([...base, "--targets", "--dry-run"])).toThrow();
    expect(() =>
      parseNpmPublishArguments([...base, "--targets=macos-arm64", "--targets", "macos-x64"]),
    ).toThrow("may only be provided once");
  });

  it("rejects incomplete release artifacts before publishing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-publish-"));
    try {
      await expect(createNpmPublishPlan({ artifactsRoot: root, version: "0.1.0" })).rejects.toThrow(
        "missing npm release tarball",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
