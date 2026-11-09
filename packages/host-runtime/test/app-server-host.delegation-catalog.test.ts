import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DELEGATION_CATALOG_METHOD,
  type CodexAccountListResult,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { afterEach, expect, it } from "vitest";

import { closeFixture, createFixture, requestId, writeRequest } from "./app-server-host-fixture.js";

const hosts = new Set<ReturnType<typeof createFixture>>();
const directories = new Set<string>();
afterEach(async () => {
  for (const host of hosts) await closeFixture(host);
  hosts.clear();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function dataDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-delegation-catalog-"));
  directories.add(directory);
  return directory;
}

function host(directory: string, instanceId: string) {
  let account: CodexAccountListResult = {
    version: 2,
    currentAccountId: "current",
    phase: "ready",
    instanceId,
    revision: 0,
    accounts: [{ accountId: "current", label: "Current", email: "first@example.com" }],
  };
  const fixture = createFixture({
    mappingStoreDirectory: directory,
    accountControl: { snapshot: () => account, currentAccountId: () => account.currentAccountId },
  });
  hosts.add(fixture);
  const probes: ((model: string | null) => void)[] = [];
  fixture.official.stdin.setEncoding("utf8");
  let pending = "";
  fixture.official.stdin.on("data", (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const request = JSON.parse(pending.slice(0, newline)) as JsonObject;
      pending = pending.slice(newline + 1);
      if (request.id === undefined) continue;
      const { id } = request;
      if (request.method !== "model/list") {
        writeRequest(fixture.official.stdout, { id, result: {} });
        continue;
      }
      probes.push((model) =>
        writeRequest(
          fixture.official.stdout,
          model
            ? { id, result: { data: [{ model, displayName: model, isDefault: true }] } }
            : { id, error: { code: -32000, message: "Model service temporarily unavailable" } },
        ),
      );
    }
  });
  let nextId = 0;
  const request = async (method: string, params: JsonObject) => {
    await fixture.ready;
    const id = ++nextId;
    writeRequest(fixture.desktopInput, { id, method, params });
    return fixture.collector.waitFor((message) => requestId(message, id));
  };
  return {
    request,
    catalog(action: "snapshot" | "refresh", params: JsonObject = { cwd: "/work" }) {
      return request(DELEGATION_CATALOG_METHOD, {
        harnessId: "codex",
        hostId: "local",
        instanceId,
        revision: account.revision,
        action,
        ...params,
      });
    },
    account(email?: string) {
      account = {
        ...account,
        revision: account.revision + 1,
        accounts: [{ accountId: "current", label: "Current", ...(email ? { email } : {}) }],
      };
    },
    probes,
    async complete(index: number, model: string | null) {
      await expect.poll(() => probes.length).toBeGreaterThan(index);
      probes[index]?.(model);
    },
    async close() {
      await closeFixture(fixture);
      hosts.delete(fixture);
    },
  };
}

function expectModel(response: { result?: JsonValue }, label: string) {
  expect(response.result).toMatchObject({ catalog: { models: [{ label }] } });
}

async function catalogFiles(directory: string) {
  const root = path.join(directory, "delegation-catalog-v1");
  return (await readdir(root, { recursive: true }).catch(() => []))
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(root, file));
}

it("reads the last successful directory across startup and refreshes once per Host scope", async () => {
  const directory = await dataDirectory();
  const first = host(directory, "first-start");
  expect((await first.catalog("snapshot")).result).toBeNull();
  const [refresh, joined] = [first.catalog("refresh"), first.catalog("refresh")];
  await first.complete(0, "before-restart");
  expectModel(await refresh, "before-restart");
  expect(await joined).toMatchObject({ result: (await refresh).result });
  expectModel(await first.catalog("refresh"), "before-restart");
  expect(first.probes).toHaveLength(1);
  await first.close();

  const restarted = host(directory, "second-start");
  expect(
    (await restarted.catalog("snapshot", { cwd: "/work", instanceId: "first-start" })).result,
  ).toBeNull();
  expectModel(await restarted.catalog("snapshot"), "before-restart");
  for (const scope of [
    { cwd: "/elsewhere" },
    { threadId: "/work" },
    { cwd: "/work", hostId: "remote" },
  ]) {
    expect((await restarted.catalog("snapshot", scope)).result).toBeNull();
  }
  expect(restarted.probes).toHaveLength(0);
  const work = restarted.catalog("refresh");
  const elsewhere = restarted.catalog("refresh", { cwd: "/elsewhere" });
  await restarted.complete(1, "other-workspace");
  expectModel(await elsewhere, "other-workspace");
  await restarted.complete(0, "after-restart");
  expectModel(await work, "after-restart");
  expectModel(await restarted.catalog("snapshot"), "after-restart");
  expect(await catalogFiles(directory)).toHaveLength(2);
});

it("retains the last good snapshot on failure and fences stale or unknown accounts", async () => {
  const directory = await dataDirectory();
  const first = host(directory, "first-start");
  const initial = first.catalog("refresh");
  await first.complete(0, "last-good");
  expectModel(await initial, "last-good");
  await first.close();

  const restarted = host(directory, "second-start");
  const [file] = await catalogFiles(directory);
  if (!file) throw new Error("Expected a persistent catalog file");
  const before = await readFile(file, "utf8");
  expect(before).not.toContain("first@example.com");
  const failing = restarted.catalog("refresh");
  await restarted.complete(0, null);
  expect(await failing).toMatchObject({
    error: { message: "Model service temporarily unavailable" },
  });
  expectModel(await restarted.catalog("snapshot"), "last-good");
  expect(await readFile(file, "utf8")).toBe(before);

  const retry = restarted.catalog("refresh");
  await restarted.complete(1, "recovered");
  expectModel(await retry, "recovered");
  restarted.account("first@example.com");
  const oldAccount = restarted.catalog("refresh");
  await expect.poll(() => restarted.probes.length).toBe(3);
  restarted.account("second@example.com");
  expect((await restarted.catalog("snapshot")).result).toBeNull();
  const secondAccount = restarted.catalog("refresh");
  await restarted.complete(3, "different-account");
  expectModel(await secondAccount, "different-account");
  await restarted.complete(2, "late-old-account");
  expect((await oldAccount).result).toBeNull();

  restarted.account();
  expect((await restarted.catalog("snapshot")).result).toBeNull();
  expect((await restarted.catalog("refresh")).result).toBeNull();
  const pi = await restarted.request("codexhost/harness/inspect", {
    harnessId: "pi",
    cwd: "/work",
    refresh: true,
  });
  expect(pi.result).toMatchObject({ status: "ready" });
  expect(await catalogFiles(directory)).toHaveLength(2);
  restarted.account("first@example.com");
  expectModel(await restarted.catalog("snapshot"), "recovered");
});

it.each(["{", JSON.stringify({ version: 0, catalog: null })])(
  "ignores a damaged or obsolete snapshot and replaces it on refresh (%s)",
  async (content) => {
    const directory = await dataDirectory();
    const first = host(directory, "first-start");
    const initial = first.catalog("refresh");
    await first.complete(0, "old");
    await initial;
    await first.close();
    const [file] = await catalogFiles(directory);
    if (!file) throw new Error("Expected a persistent catalog file");
    await writeFile(file, content);

    const restarted = host(directory, "second-start");
    expect((await restarted.catalog("snapshot")).result).toBeNull();
    const refresh = restarted.catalog("refresh");
    await restarted.complete(0, "valid");
    expectModel(await refresh, "valid");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
  },
);
