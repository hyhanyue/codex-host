import { harnessInspectionSchema } from "@codexhost/shared-contracts";
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
import type { RendererRequestOptions } from "./renderer-request-sender.js";

type Catalog = Extract<HarnessInspection, { status: "ready" }>;
type Location = { threadId: HostThreadId } | { cwd: string };
interface CatalogScope {
  key: string;
  targetKey: string;
  cacheable: boolean;
  changingCredentials: boolean;
  disk?: { window: Window; key: string; needsRefresh: boolean };
  persistent?: Omit<DelegationCatalogParams, "action" | "threadId" | "cwd"> & Location;
}

export class DelegationCatalogScopeChanged extends Error {}

const maxAgeMs = 60 * 60_000;
const retryDelayMs = 30_000;
const maxEntries = 32;
const storagePrefix = "codexhost.model-catalog.v1:antigravity:";
const maxSnapshotLength = 256 * 1024;

function clearSavedCatalogs(window: Window): void {
  try {
    const storage = window.localStorage;
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(storagePrefix)) storage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable in a restricted Desktop renderer.
  }
}
const credentialsChanged = "codexhost:delegation-credentials-changed";
const credentialEpochs = new WeakMap<
  RendererModelClient["inspectHarness"],
  Map<string, { revision: number; pending: number }>
>();

export function subscribeDelegationCatalogInvalidation(
  document: Document,
  listener: () => void,
  onFocus = true,
): () => void {
  const window = document.defaultView;
  if (onFocus) window?.addEventListener("focus", listener);
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
  if (harnessId === "antigravity" && typeof window !== "undefined") clearSavedCatalogs(window);
  invalidate(1);
  return () => invalidate(-1);
}

export function delegationCatalogScope(
  document: Document,
  client: RendererModelClient,
  hostId: string,
  harnessId: HarnessId,
  location: Location | undefined,
  pluginVersion: string | undefined,
  accounts: RendererCodexAccountState | null | undefined,
): CatalogScope {
  const ownAccounts = accounts?.client === client ? accounts : undefined;
  const account = ownAccounts?.accounts.find(
    ({ accountId }) => accountId === ownAccounts.readyAccountId,
  );
  const credentials = credentialEpochs.get(client.inspectHarness)?.get(harnessId);
  const changingCredentials = Boolean(credentials?.pending);
  // Cache identity follows the Host, workspace, plugin and Account, not window focus.
  // Credential operations invalidate immediately; native external login changes
  // are picked up by the next hourly refresh or an explicit refresh.
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
  const target = [hostId, harnessId, location ?? null];
  const persistent =
    harnessId === "codex" &&
    location &&
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
  const owner = document.defaultView;
  // A remote Host ID or a Thread ID is not a durable workspace identity here.
  const disk =
    hostId === "local" &&
    harnessId === "antigravity" &&
    pluginVersion &&
    owner &&
    (!location || "cwd" in location)
      ? {
          window: owner,
          key: storagePrefix + JSON.stringify([pluginVersion, location?.cwd ?? null]),
          needsRefresh: credentials !== undefined,
        }
      : undefined;
  return {
    key: JSON.stringify([...target, pluginVersion, accountScope]),
    targetKey: JSON.stringify(target),
    cacheable: !changingCredentials && (harnessId !== "codex" || ownAccounts?.phase === "ready"),
    changingCredentials,
    ...(persistent ? { persistent } : {}),
    ...(disk ? { disk } : {}),
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
  retryAt?: number;
  localAntigravity?: boolean;
}

class DelegationCatalogCache {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, { key: string; result: Promise<Catalog> }>();
  readonly #diskReads = new Set<string>();
  #diskGeneration = 0;
  readonly #preloads = new Map<string, Promise<Catalog | undefined>>();

  constructor(private readonly client: RendererModelClient) {}

  read(key: string): Catalog | undefined {
    return this.#entry(key)?.catalog;
  }

  restore(scope: CatalogScope): Catalog | undefined {
    const { key, disk, cacheable } = scope;
    const current = this.read(key);
    if (current || !disk || !cacheable || this.#diskReads.has(key)) return current;
    this.#diskReads.add(key);
    if (this.#diskReads.size > maxEntries) {
      const oldest = this.#diskReads.values().next();
      if (!oldest.done) this.#diskReads.delete(oldest.value);
    }
    try {
      const raw = disk.window.localStorage.getItem(disk.key);
      if (!raw || raw.length > maxSnapshotLength) return undefined;
      const result = harnessInspectionSchema.safeParse(JSON.parse(raw));
      if (!result.success || result.data.status !== "ready") return undefined;
      this.#remember(key, {
        catalog: result.data,
        refreshed: false,
        expiresAt: 0,
        localAntigravity: true,
      });
      return result.data;
    } catch {
      return undefined;
    }
  }

  invalidate(scope: CatalogScope): void {
    this.#entries.delete(scope.key);
    if (scope.disk) {
      this.#diskGeneration++;
      for (const [key, entry] of this.#entries) {
        if (entry.localAntigravity) this.#entries.delete(key);
      }
      clearSavedCatalogs(scope.disk.window);
    }
  }

  #save(disk: NonNullable<CatalogScope["disk"]>, catalog: Catalog): void {
    try {
      const storage = disk.window.localStorage;
      const raw = JSON.stringify(catalog);
      if (raw.length > maxSnapshotLength) return;
      storage.setItem(disk.key, raw);
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
        (key): key is string => key !== disk.key && key?.startsWith(storagePrefix) === true,
      );
      for (const key of keys.slice(0, Math.max(0, keys.length + 1 - maxEntries)))
        storage.removeItem(key);
    } catch {
      // A cache write must not affect a usable native catalog.
    }
  }

  isFresh(key: string): boolean {
    const entry = this.#entry(key);
    return Boolean(
      entry?.catalog &&
      ((entry.refreshed && entry.expiresAt > Date.now()) ||
        (entry.retryAt !== undefined && entry.retryAt > Date.now())),
    );
  }

  isRefreshing(key: string): boolean {
    return [...this.#flights.values()].some((flight) => flight.key === key);
  }

  #entry(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    // Keep expired snapshots visible while refresh() replaces them in the background.
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
    scope: CatalogScope,
    input: HarnessInspectParams,
    stillInScope: () => boolean,
    options?: RendererRequestOptions,
  ): Promise<Catalog> {
    const { key, targetKey, cacheable, persistent, disk } = scope;
    const cached = this.#entry(key);
    const diskGeneration = this.#diskGeneration;
    const isDiskCurrent = () => !disk || diskGeneration === this.#diskGeneration;
    if (input.refresh !== true && cached?.catalog && this.isFresh(key))
      return Promise.resolve(cached.catalog);
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
        // A fresh Renderer can reuse a same-workspace inspection already warmed by the Host.
        const params = {
          ...input,
          refresh: input.refresh === true || Boolean(cached?.catalog) || !disk || disk.needsRefresh,
        };
        return options
          ? this.client.inspectHarness(params, options)
          : this.client.inspectHarness(params);
      })
      .then((inspection) => {
        if (!isDiskCurrent()) throw new DelegationCatalogScopeChanged("Agent credentials changed");
        if (inspection.status !== "ready") {
          if (
            disk &&
            isLatest() &&
            stillInScope() &&
            (inspection.status === "notInstalled" ||
              inspection.error.code === "authenticationRequired")
          ) {
            this.invalidate(scope);
            throw new DelegationCatalogScopeChanged(inspection.error.message);
          }
          throw new Error(inspection.error.message);
        }
        if (cacheable && isLatest() && stillInScope()) {
          if (disk) this.#save(disk, inspection);
          this.#remember(key, {
            catalog: inspection,
            refreshed: true,
            ...(disk ? { localAntigravity: true } : {}),
            expiresAt: Date.now() + maxAgeMs,
          });
        }
        return inspection;
      })
      .catch((error: unknown) => {
        if (
          error instanceof DelegationCatalogScopeChanged &&
          isLatest() &&
          stillInScope() &&
          isDiskCurrent()
        )
          this.#entries.delete(key);
        else if (cached?.catalog && isLatest() && stillInScope())
          cached.retryAt = Date.now() + retryDelayMs;
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
