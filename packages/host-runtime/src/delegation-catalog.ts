import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  delegationCatalogResultSchema,
  jsonObjectSchema,
  type CodexAccountListResult,
  type DelegationCatalogParams,
  type DelegationCatalogResult,
} from "@codexhost/shared-contracts";

import { defaultMappingStoreDirectory } from "./external-thread-repository.js";

type Catalog = NonNullable<DelegationCatalogResult>;
const digest = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export function delegationCatalogKey(
  input: DelegationCatalogParams,
  state: CodexAccountListResult,
): string | undefined {
  if (
    state.phase !== "ready" ||
    state.instanceId !== input.instanceId ||
    state.revision !== input.revision
  )
    return undefined;
  const account = state.accounts.find(({ accountId }) => accountId === state.currentAccountId);
  if (!account || (account.accountId === "current" && !account.email)) return undefined;
  const location = "threadId" in input ? ["thread", input.threadId] : ["workspace", input.cwd];
  return digest([
    input.hostId,
    input.harnessId,
    location,
    account.accountId,
    account.email,
    account.planType,
  ]);
}

/** One per Host runtime, shared by its Desktop connections. */
export class DelegationCatalogStore {
  readonly #directory: string;
  readonly #entries = new Map<string, { catalog: Catalog; epoch?: string }>();
  readonly #flights = new Map<string, { epoch: string; result: Promise<Catalog | null> }>();
  readonly #reads = new Map<string, Promise<void>>();
  #preloaded = false;

  constructor(environment: NodeJS.ProcessEnv, codexHome: string) {
    this.#directory = path.join(
      path.dirname(defaultMappingStoreDirectory(environment)),
      "delegation-catalog-v1",
      digest([codexHome]),
    );
    void this.#preload();
  }

  async #preload(): Promise<void> {
    const files = await readdir(this.#directory).catch(() => []);
    for (const file of files) {
      const key = file.match(/^([a-f0-9]{64})\.json$/u)?.[1];
      if (key && !this.#entries.has(key)) await this.#read(key);
    }
    this.#preloaded = true;
  }

  #read(key: string): Promise<void> {
    const active = this.#reads.get(key);
    if (active) return active;
    const result = readFile(path.join(this.#directory, `${key}.json`), "utf8")
      .then((content) => {
        const record = jsonObjectSchema.parse(JSON.parse(content));
        if (record.version !== 1 || this.#entries.has(key)) return;
        const catalog = delegationCatalogResultSchema.unwrap().parse(record.catalog);
        this.#entries.set(key, { catalog });
      })
      .catch(() => {
        // Older or interrupted data is a cache miss for this scope only.
      })
      .finally(() => this.#reads.delete(key));
    this.#reads.set(key, result);
    return result;
  }

  async snapshot(key: string): Promise<Catalog | null> {
    // A fast first open can read just its own file while startup warms the rest.
    if (!this.#entries.has(key) && !this.#preloaded) await this.#read(key);
    return this.#entries.get(key)?.catalog ?? null;
  }

  refresh(
    key: string,
    epoch: string,
    inspect: () => Promise<Catalog>,
    isCurrent: () => boolean,
  ): Promise<Catalog | null> {
    const current = this.#entries.get(key);
    if (current?.epoch === epoch) return Promise.resolve(current.catalog);
    const active = this.#flights.get(key);
    if (active?.epoch === epoch) return active.result;
    const previous = active?.result.catch(() => null) ?? Promise.resolve(null);
    const result = previous
      .then(async () => {
        if (this.#flights.get(key) !== flight || !isCurrent()) return null;
        const catalog = await inspect();
        const canCommit = () => this.#flights.get(key) === flight && isCurrent();
        if (!canCommit()) return null;
        await this.#write(key, catalog, canCommit);
        if (!canCommit()) return null;
        this.#entries.set(key, { catalog, epoch });
        return catalog;
      })
      .finally(() => {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
      });
    const flight = { epoch, result };
    this.#flights.set(key, flight);
    return result;
  }

  async #write(key: string, catalog: Catalog, isCurrent: () => boolean): Promise<void> {
    const file = path.join(this.#directory, `${key}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ version: 1, catalog }), {
        mode: 0o600,
        flag: "wx",
      });
      if (isCurrent()) await rename(temporary, file);
    } catch {
      // A storage failure leaves the previous on-disk snapshot intact.
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
