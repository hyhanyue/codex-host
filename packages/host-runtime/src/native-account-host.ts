import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  currentCodexAccountFromOfficialRead,
  type CodexAccountControl,
} from "./account/codex-account-control.js";
import { officialEnvironment } from "./app-server-host.js";
import { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { createOwnedLoopbackBackend } from "./codex-runtime/owned-official-backends.js";

export interface PreparedLocalCodex {
  officialRuntimeScope: OfficialRuntimeScope;
  accountControl: CodexAccountControl;
  close(): Promise<void>;
}

async function canonicalCodexHome(home: string): Promise<string> {
  const absolute = path.resolve(home);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalCodexHome(parent), path.basename(absolute));
  }
}

export async function prepareLocalCodex(input: {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  diagnosticOutput: Writable;
}): Promise<PreparedLocalCodex> {
  const home = await canonicalCodexHome(
    input.environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  await mkdir(home, { recursive: true });
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: input.diagnosticOutput,
    // Local Desktop connections outlive a failed official backend generation.
    recovery: {},
    createBackend: () =>
      createOwnedLoopbackBackend({
        stockCodexPath: input.stockCodexPath,
        cwd: home,
        arguments: input.arguments,
        environment: { ...officialEnvironment(input.environment), CODEX_HOME: home },
      }),
  });
  // controlRequest requires an initialized client on this same owned backend.
  // This connection only reads native identity; it does not own authentication.
  const identityReader = scope.owner.attachManagement(async () => {});
  identityReader.configure({
    clientInfo: { name: "codexhost_identity_reader", version: "1" },
    capabilities: { experimentalApi: true },
  });
  let current: ReturnType<typeof currentCodexAccountFromOfficialRead> = null;
  const instanceId = randomUUID();
  let revision = 0;
  let pending:
    | { revision: number; result: ReturnType<NonNullable<CodexAccountControl["refresh"]>> }
    | undefined;
  const listeners = new Set<() => void>();
  const snapshot = () => ({
    version: 2 as const,
    currentAccountId: current?.accountId ?? null,
    phase: scope.gate.phase,
    instanceId,
    revision,
    accounts: current ? [current] : [],
  });
  const changed = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const invalidate = () => {
    current = null;
    changed();
  };
  const refresh: NonNullable<CodexAccountControl["refresh"]> = async () => {
    if (scope.closed) throw new Error("Official Account is unavailable");
    if (scope.gate.phase !== "ready") return snapshot();
    if (pending?.revision === revision) return pending.result;
    const before = revision;
    const result = scope.owner
      .controlRequest("account/read", { refreshToken: false })
      .then((response) => {
        if (before !== revision) return refresh();
        if (response.error) throw new Error("Official Account read failed");
        const next = currentCodexAccountFromOfficialRead(response.result);
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          current = next;
          changed();
        }
        return snapshot();
      })
      .catch((error: unknown) => {
        if (before === revision && current) invalidate();
        throw error;
      })
      .finally(() => {
        if (pending?.result === result) pending = undefined;
      });
    pending = { revision: before, result };
    return result;
  };
  const unsubscribe = scope.gate.subscribe(() => {
    invalidate();
    if (scope.gate.phase === "ready") {
      void refresh().catch(() => {
        input.diagnosticOutput.write("codexhost: Codex Account identity could not be read\n");
      });
    }
  });
  try {
    await scope.start();
  } catch (error) {
    unsubscribe();
    await scope.close();
    identityReader.close();
    throw error;
  }
  return {
    officialRuntimeScope: scope,
    accountControl: {
      snapshot,
      refresh,
      invalidate,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      currentAccountId: () => current?.accountId ?? null,
    },
    close: async () => {
      unsubscribe();
      await scope.close();
      identityReader.close();
    },
  };
}
