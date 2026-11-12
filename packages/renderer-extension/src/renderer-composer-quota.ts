import {
  harnessIdSchema,
  type AccountCreditsSnapshot,
  type HarnessAccountUnavailableReason,
} from "@codexhost/shared-contracts";
import type { RendererCodexAccountState } from "./renderer-codex-account-state.js";
import type { RendererModelClient } from "./renderer-model-client.js";

export type ComposerQuotaView =
  | { status: "loading" | "empty" | HarnessAccountUnavailableReason }
  | { status: "ready"; credits: AccountCreditsSnapshot; plan?: string | undefined };

export interface ComposerQuotaSources {
  client: object;
  accountKey: string | null;
  current: string;
  agents: readonly { id: string; label: string }[];
  read(agent: string, refresh: boolean): Promise<ComposerQuotaView>;
}

export async function readComposerQuota(
  client: RendererModelClient,
  accounts: RendererCodexAccountState | null,
  agent: string,
  refresh: boolean,
): Promise<ComposerQuotaView> {
  if (agent === "codex") {
    if (!accounts || !client.inspectCodexAccountUsage) return { status: "unsupported" };
    const accountId = accounts.readyAccountId;
    if (!accountId) return { status: "empty" };
    const result = await client.inspectCodexAccountUsage({ accountId, refresh });
    if (result.accountId !== accountId || accounts.readyAccountId !== accountId)
      return { status: "empty" };
    if (result.refreshFailed) return { status: "failed" };
    return result.accountCredits
      ? { status: "ready", credits: result.accountCredits }
      : { status: "empty" };
  }
  if (!client.inspectHarnessAccount) return { status: "unsupported" };
  const result = await client.inspectHarnessAccount({
    harnessId: harnessIdSchema.parse(agent),
    refresh,
  });
  if (result.harnessId !== agent) return { status: "failed" };
  if (result.account?.credits)
    return { status: "ready", credits: result.account.credits, plan: result.account.plan };
  return { status: result.unavailableReason ?? "empty" };
}
