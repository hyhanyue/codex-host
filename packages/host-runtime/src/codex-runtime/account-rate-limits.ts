import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";
import {
  projectCodexAccountQuota,
  observeCodexRateLimitResetCredits,
  observeCodexRateLimits,
  type CodexRateLimitResetCredits,
  type JsonObject,
} from "@codexhost/protocol-core";

interface AccountSnapshot {
  usage: HostUsage | null;
  credits: AccountCreditsSnapshot | null;
  resetCredits: CodexRateLimitResetCredits | null;
  observedAt: string | null;
  freshUntil: number;
  refresh?: Promise<AccountRateLimitRefresh>;
}

export interface AccountRateLimitRefresh {
  status: "live" | "cached" | "empty" | "failed";
  observedAt: string | null;
}

/** Quota and in-flight reads belong to one Account, never the Desktop default. */
export class AccountRateLimits {
  readonly #accounts = new Map<string, AccountSnapshot>();

  get(accountId: string): HostUsage | null {
    return this.#accounts.get(accountId)?.usage ?? null;
  }

  getCredits(accountId: string): AccountCreditsSnapshot | null {
    return this.#accounts.get(accountId)?.credits ?? null;
  }

  getResetCredits(accountId: string): CodexRateLimitResetCredits | null {
    return this.#accounts.get(accountId)?.resetCredits ?? null;
  }

  reset(accountId: string): void {
    this.#accounts.delete(accountId);
  }

  #state(accountId: string): AccountSnapshot {
    let state = this.#accounts.get(accountId);
    if (!state) {
      state = { usage: null, credits: null, resetCredits: null, observedAt: null, freshUntil: 0 };
      this.#accounts.set(accountId, state);
    }
    return state;
  }

  observe(accountId: string, usage: Partial<HostUsage>): void {
    const state = this.#state(accountId);
    state.freshUntil = 0;
    if (state.usage) return;
    try {
      state.usage = parseHostUsage(usage);
      state.observedAt = new Date().toISOString();
    } catch {
      // Preserve the previous snapshot when the native update is malformed.
    }
  }

  refresh(
    accountId: string,
    request: () => Promise<JsonObject>,
    force = false,
  ): Promise<AccountRateLimitRefresh> {
    const state = this.#state(accountId);
    if (!force && state.credits && Date.now() < state.freshUntil) {
      return Promise.resolve({ status: "cached", observedAt: state.observedAt });
    }
    if (state.refresh) return state.refresh;
    state.refresh = request()
      .then((response): AccountRateLimitRefresh => {
        if (this.#accounts.get(accountId) !== state) {
          return { status: "failed", observedAt: null };
        }
        const usage = observeCodexRateLimits(response);
        state.resetCredits = observeCodexRateLimitResetCredits(response);
        const credits = projectCodexAccountQuota(response, state.resetCredits);
        if (!credits) {
          state.usage = null;
          state.credits = null;
          state.observedAt = null;
          state.freshUntil = 0;
          return { status: "empty", observedAt: null };
        }
        state.credits = credits;
        state.usage = usage ? parseHostUsage(usage) : null;
        state.observedAt = new Date().toISOString();
        state.freshUntil = Date.now() + 15_000;
        return { status: "live", observedAt: state.observedAt };
      })
      .catch((): AccountRateLimitRefresh => {
        state.freshUntil = 0;
        return { status: "failed", observedAt: state.observedAt };
      })
      .finally(() => {
        delete state.refresh;
      });
    return state.refresh;
  }
}
