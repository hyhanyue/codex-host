import type {
  DelegationCatalogParams,
  HarnessId,
  HarnessInspectParams,
  HarnessInspection,
  HostThreadId,
} from "@codexhost/shared-contracts";

import type { RendererCodexAccountState } from "./renderer-codex-account-state.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";

type Catalog = Extract<HarnessInspection, { status: "ready" }>;
type Location = { threadId: HostThreadId } | { cwd: string };
interface CatalogScope {
  key: string;
  targetKey: string;
  cacheable: boolean;
  changingCredentials: boolean;
  persistent?: Omit<DelegationCatalogParams, "action" | "threadId" | "cwd"> & Location;
}

export class DelegationCatalogScopeChanged extends Error {}

const maxAgeMs = 60_000;
const maxEntries = 32;
const credentialsChanged = "codexhost:delegation-credentials-changed";
let nextForegroundRevision = 0;
const foregroundEpochs = new WeakMap<Document, { revision: number }>();
const credentialEpochs = new WeakMap<
  RendererModelClient["inspectHarness"],
  Map<string, { revision: number; pending: number }>
>();

function foregroundRevision(document: Document): number {
  let epoch = foregroundEpochs.get(document);
  if (!epoch) {
    const state = { revision: ++nextForegroundRevision };
    const invalidate = () => {
      state.revision = ++nextForegroundRevision;
    };
    document.defaultView?.addEventListener("blur", invalidate);
    document.defaultView?.addEventListener("focus", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    foregroundEpochs.set(document, (epoch = state));
  }
  return epoch.revision;
}

export function subscribeDelegationCatalogInvalidation(
  document: Document,
  listener: () => void,
): () => void {
  // Register the epoch update before the UI rereads its scope.
  foregroundRevision(document);
  const window = document.defaultView;
  window?.addEventListener("focus", listener);
  window?.addEventListener(credentialsChanged, listener);
  return () => {
    window?.removeEventListener("focus", listener);
    window?.removeEventListener(credentialsChanged, listener);
  };
}

/** Credential writes can change the directory even when their response fails. */
export function beginDelegationCatalogCredentialChange(
  inspect: RendererModelClient["inspectHarness"],
  harnessId: string,
): () => void {
  let byHarness = credentialEpochs.get(inspect);
  if (!byHarness) credentialEpochs.set(inspect, (byHarness = new Map()));
  let epoch = byHarness.get(harnessId);
  if (!epoch) byHarness.set(harnessId, (epoch = { revision: 0, pending: 0 }));
  const state = epoch;
  const invalidate = (pendingDelta: number) => {
    state.revision += 1;
    state.pending += pendingDelta;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(credentialsChanged));
  };
  invalidate(1);
  return () => invalidate(-1);
}

export function delegationCatalogScope(
  document: Document,
  client: RendererModelClient,
  hostId: string,
  harnessId: HarnessId,
  location: Location,
  pluginVersion: string | undefined,
  accounts: RendererCodexAccountState | null | undefined,
): CatalogScope {
  const ownAccounts = accounts?.client === client ? accounts : undefined;
  const account = ownAccounts?.accounts.find(
    ({ accountId }) => accountId === ownAccounts.readyAccountId,
  );
  const credentials = credentialEpochs.get(client.inspectHarness)?.get(harnessId);
  const changingCredentials = Boolean(credentials?.pending);
  // Native external logins are owned by the Harness. Discard their warm snapshots
  // across foreground changes as well as credential operations made here.
  const accountScope =
    harnessId === "codex"
      ? [
          ownAccounts?.instanceId,
          ownAccounts?.revision,
          ownAccounts?.phase,
          account?.accountId,
          account?.email,
          account?.label,
          account?.planType,
        ]
      : credentials?.revision;
  const target = [hostId, harnessId, location];
  const persistent =
    harnessId === "codex" &&
    client.delegationCatalog &&
    ownAccounts?.instanceId &&
    account &&
    (account.accountId !== "current" || account.email)
      ? {
          hostId,
          harnessId: "codex" as const,
          instanceId: ownAccounts.instanceId,
          revision: ownAccounts.revision,
          ...location,
        }
      : undefined;
  return {
    key: JSON.stringify([...target, pluginVersion, foregroundRevision(document), accountScope]),
    targetKey: JSON.stringify(target),
    cacheable: !changingCredentials && (harnessId !== "codex" || ownAccounts?.phase === "ready"),
    changingCredentials,
    ...(persistent ? { persistent } : {}),
  };
}

const caches = new WeakMap<RendererModelClient, DelegationCatalogCache>();

export function delegationCatalogCache(client: RendererModelClient): DelegationCatalogCache {
  let cache = caches.get(client);
  if (!cache) caches.set(client, (cache = new DelegationCatalogCache(client)));
  return cache;
}

interface Entry {
  catalog?: Catalog;
  refreshed: boolean;
  expiresAt: number;
}

class DelegationCatalogCache {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, { key: string; result: Promise<Catalog> }>();
  readonly #preloads = new Map<string, Promise<Catalog | undefined>>();

  constructor(private readonly client: RendererModelClient) {}

  read(key: string): Catalog | undefined {
    return this.#entry(key)?.catalog;
  }

  #entry(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.#entries.set(key, entry);
    return entry;
  }

  #remember(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size > maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }

  preload(
    { key, persistent }: CatalogScope,
    stillInScope: () => boolean,
  ): Promise<Catalog | undefined> {
    const cached = this.#entry(key);
    if (cached || !persistent || !this.client.delegationCatalog)
      return Promise.resolve(cached?.catalog);
    const active = this.#preloads.get(key);
    if (active) return active;
    const result = this.client
      .delegationCatalog({ ...persistent, action: "snapshot" })
      .catch(() => null)
      .then((catalog) => {
        if (!stillInScope()) return undefined;
        const latest = this.#entry(key);
        if (latest) return latest.catalog;
        this.#remember(key, {
          ...(catalog ? { catalog } : {}),
          refreshed: false,
          expiresAt: Date.now() + maxAgeMs,
        });
        return catalog ?? undefined;
      })
      .finally(() => this.#preloads.delete(key));
    this.#preloads.set(key, result);
    return result;
  }

  refresh(
    { key, targetKey, cacheable, persistent }: CatalogScope,
    input: HarnessInspectParams,
    stillInScope: () => boolean,
  ): Promise<Catalog> {
    const cached = this.#entry(key);
    if (cached?.refreshed && cached.catalog) return Promise.resolve(cached.catalog);
    const active = this.#flights.get(targetKey);
    if (active?.key === key) return active.result;
    // Some Adapters coalesce refreshes for the same workspace. Let the previous
    // scope finish before asking that Adapter for the new scope's catalog.
    const previous = active?.result.catch(() => undefined) ?? Promise.resolve();
    const isLatest = (): boolean => this.#flights.get(targetKey) === flight;
    const result = previous
      .then(async () => {
        if (!isLatest() || !stillInScope()) throw new DelegationCatalogScopeChanged();
        if (persistent && this.client.delegationCatalog) {
          try {
            const catalog = await this.client.delegationCatalog({
              ...persistent,
              action: "refresh",
            });
            if (!catalog) throw new DelegationCatalogScopeChanged();
            return catalog;
          } catch (error) {
            if (!(error instanceof RendererMethodUnavailableError)) throw error;
          }
        }
        return this.client.inspectHarness({ ...input, refresh: true });
      })
      .then((inspection) => {
        if (inspection.status !== "ready") throw new Error(inspection.error.message);
        if (cacheable && isLatest() && stillInScope()) {
          this.#remember(key, {
            catalog: inspection,
            refreshed: true,
            expiresAt: Date.now() + maxAgeMs,
          });
        }
        return inspection;
      })
      .catch((error: unknown) => {
        if (error instanceof DelegationCatalogScopeChanged && isLatest() && stillInScope())
          this.#entries.delete(key);
        throw error;
      })
      .finally(() => {
        if (isLatest()) this.#flights.delete(targetKey);
      });
    const flight = { key, result };
    this.#flights.set(targetKey, flight);
    return result;
  }
}
