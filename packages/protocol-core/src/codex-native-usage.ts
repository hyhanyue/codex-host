import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finitePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function optionalReset(value: unknown): number | undefined {
  const seconds = nonNegativeSafeInteger(value);
  return seconds !== undefined && seconds <= 8_640_000_000_000 ? seconds : undefined;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

interface RateLimitCandidate {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

function parseRateLimitWindow(value: unknown): RateLimitWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = finitePercent(value.usedPercent);
  const windowDurationMins = nonNegativeSafeInteger(value.windowDurationMins);
  if (usedPercent === undefined) return null;
  const resetsAt = optionalReset(value.resetsAt);
  return {
    usedPercent,
    ...(windowDurationMins ? { windowDurationMins } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseRateLimitCandidate(
  value: unknown,
  options: { genericOnly?: boolean } = {},
): RateLimitCandidate | null {
  if (!isRecord(value)) return null;
  if (
    options.genericOnly &&
    value.limitId !== undefined &&
    value.limitId !== null &&
    value.limitId !== "codex"
  ) {
    // Rolling notifications can carry a model-specific snapshot (for
    // example, GPT-5.3-Codex-Spark). It must not replace the account-wide
    // `codex` bucket in the Usage popover.
    return null;
  }
  const primary = parseRateLimitWindow(value.primary);
  const secondary = parseRateLimitWindow(value.secondary);
  return primary || secondary ? { primary, secondary } : null;
}

function rateLimitCandidates(value: unknown): RateLimitCandidate[] {
  if (!isRecord(value)) return [];
  const result = isRecord(value.result) ? value.result : value;
  if (!isRecord(result)) return [];
  const candidates: RateLimitCandidate[] = [];
  const base = parseRateLimitCandidate(result.rateLimits, { genericOnly: true });
  if (base) candidates.push(base);
  // `rateLimitsByLimitId` contains model-specific buckets (for example,
  // GPT-5.3-Codex-Spark). Usage reports the account-level limit, so these
  // buckets must not replace or augment the generic account snapshot.
  const notificationParams = isRecord(value.params) ? value.params : undefined;
  const notificationSnapshot = parseRateLimitCandidate(notificationParams?.rateLimits, {
    genericOnly: true,
  });
  if (notificationSnapshot) candidates.push(notificationSnapshot);
  return candidates;
}

function candidateScore(candidate: RateLimitCandidate): number {
  return [candidate.primary, candidate.secondary].filter(
    (window) => window?.windowDurationMins === 300 || window?.windowDurationMins === 10_080,
  ).length;
}

function applyWindow(target: Partial<HostUsage>, window: RateLimitWindow | null): void {
  if (!window) return;
  const prefix =
    window.windowDurationMins === 300
      ? "planFiveHour"
      : window.windowDurationMins === 10_080
        ? "planSevenDay"
        : null;
  if (!prefix) return;
  target[`${prefix}UsedPercent` as "planFiveHourUsedPercent" | "planSevenDayUsedPercent"] =
    window.usedPercent;
  if (window.resetsAt !== undefined) {
    target[`${prefix}ResetsAtUnix` as "planFiveHourResetsAtUnix" | "planSevenDayResetsAtUnix"] =
      window.resetsAt;
  }
}

export function observeCodexRateLimits(value: unknown): Partial<HostUsage> | null {
  const candidate = rateLimitCandidates(value).sort(
    (left, right) => candidateScore(right) - candidateScore(left),
  )[0];
  if (!candidate) return null;
  const usage: Partial<HostUsage> = {};
  applyWindow(usage, candidate.primary);
  applyWindow(usage, candidate.secondary);
  try {
    return Object.keys(usage).length > 0 ? parseHostUsage(usage) : null;
  } catch {
    return null;
  }
}

export interface CodexRateLimitResetCredits {
  availableCount: number;
  nextExpiresAtUnix?: number;
  expiresAtUnix?: number[];
}

function parseAvailableCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return undefined;
}

function rateLimitResetCreditsSummary(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result = isRecord(value.result) ? value.result : value;
  const fromResult =
    isRecord(result) && isRecord(result.rateLimitResetCredits)
      ? result.rateLimitResetCredits
      : null;
  if (fromResult) return fromResult;
  const params = isRecord(value.params) ? value.params : undefined;
  return isRecord(params?.rateLimitResetCredits) ? params.rateLimitResetCredits : null;
}

export function observeCodexRateLimitResetCredits(
  value: unknown,
): CodexRateLimitResetCredits | null {
  const summary = rateLimitResetCreditsSummary(value);
  if (!summary) return null;
  const availableCount = parseAvailableCount(summary.availableCount);
  if (availableCount === undefined || availableCount === 0) return null;
  const expiresAtUnix: number[] = [];
  if (Array.isArray(summary.credits)) {
    for (const credit of summary.credits) {
      if (!isRecord(credit)) continue;
      if (credit.status !== undefined && credit.status !== "available") continue;
      const expiresAt = optionalReset(credit.expiresAt);
      if (expiresAt === undefined) continue;
      expiresAtUnix.push(expiresAt);
    }
  }
  expiresAtUnix.sort((left, right) => left - right);
  const nextExpiresAtUnix = expiresAtUnix[0];
  return {
    availableCount,
    ...(nextExpiresAtUnix !== undefined ? { nextExpiresAtUnix } : {}),
    ...(expiresAtUnix.length > 0 ? { expiresAtUnix } : {}),
  };
}

function isoFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Projects the account-wide Codex rate-limit fields into the shared Credits
 * snapshot consumed by the renderer's pill/popover. Model-specific buckets
 * have already been excluded by observeCodexRateLimits.
 */
export function projectCodexRateLimitsToCredits(
  usage: Partial<HostUsage> | null | undefined,
  resetCredits?: CodexRateLimitResetCredits | null,
): AccountCreditsSnapshot | null {
  if (!usage) return null;
  const hasFiveHour = usage.planFiveHourUsedPercent !== undefined;
  const hasSevenDay = usage.planSevenDayUsedPercent !== undefined;
  if (!hasFiveHour && !hasSevenDay) return null;

  const usedPercent = hasFiveHour ? usage.planFiveHourUsedPercent : usage.planSevenDayUsedPercent;
  if (usedPercent === undefined) return null;
  const resetsAtUnix = hasFiveHour
    ? usage.planFiveHourResetsAtUnix
    : usage.planSevenDayResetsAtUnix;
  const secondary =
    hasFiveHour && hasSevenDay && usage.planSevenDayUsedPercent !== undefined
      ? {
          product: "7-day window",
          periodType: "seven_day" as const,
          usagePercent: usage.planSevenDayUsedPercent,
          ...(usage.planSevenDayResetsAtUnix !== undefined
            ? { resetsAt: isoFromUnix(usage.planSevenDayResetsAtUnix) }
            : {}),
        }
      : undefined;
  const projectedResetCredits = projectResetCredits(resetCredits);

  return {
    usedPercent,
    periodType: hasFiveHour ? "five_hour" : "seven_day",
    ...(resetsAtUnix !== undefined ? { resetsAt: isoFromUnix(resetsAtUnix) } : {}),
    ...(secondary ? { productUsage: [secondary] } : {}),
    ...(projectedResetCredits ? { resetCredits: projectedResetCredits } : {}),
  };
}

function projectResetCredits(resetCredits?: CodexRateLimitResetCredits | null) {
  if (!resetCredits || resetCredits.availableCount <= 0) return undefined;
  return {
    availableCount: resetCredits.availableCount,
    ...(resetCredits.nextExpiresAtUnix !== undefined
      ? { nextExpiresAt: isoFromUnix(resetCredits.nextExpiresAtUnix) }
      : {}),
    ...(resetCredits.expiresAtUnix?.length
      ? { expiresAt: resetCredits.expiresAtUnix.map(isoFromUnix) }
      : {}),
  };
}

/** Keep every generic account window from a read, including new native durations. */
export function projectCodexAccountQuota(
  value: unknown,
  resetCredits?: CodexRateLimitResetCredits | null,
): AccountCreditsSnapshot | null {
  const candidate = rateLimitCandidates(value)[0];
  if (!candidate) return null;
  const windows = [candidate.primary, candidate.secondary].filter(
    (window): window is RateLimitWindow => window !== null,
  );
  const primary = windows.find((window) => window.windowDurationMins === 300) ?? windows[0];
  if (!primary) return null;
  const describe = (window: RateLimitWindow) => {
    const minutes = window.windowDurationMins;
    const periodType = minutes === 300 ? "five_hour" : minutes === 10_080 ? "seven_day" : "unknown";
    const label =
      minutes === undefined
        ? undefined
        : minutes % 1_440 === 0
          ? `${minutes / 1_440}-day window`
          : minutes % 60 === 0
            ? `${minutes / 60}-hour window`
            : `${minutes}-minute window`;
    return {
      label,
      periodType,
      ...(window.resetsAt !== undefined ? { resetsAt: isoFromUnix(window.resetsAt) } : {}),
    } as const;
  };
  const { label, ...window } = describe(primary);
  const others = windows
    .filter((value) => value !== primary)
    .map((value) => {
      const { label: product, ...window } = describe(value);
      return {
        product: product ?? "Secondary account limit",
        usagePercent: value.usedPercent,
        ...window,
      };
    });
  const resets = projectResetCredits(resetCredits);
  return {
    ...window,
    usedPercent: primary.usedPercent,
    ...(window.periodType === "unknown" && label ? { label } : {}),
    ...(others.length ? { productUsage: others } : {}),
    ...(resets ? { resetCredits: resets } : {}),
  };
}
