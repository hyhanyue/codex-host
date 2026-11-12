import {
  accountCreditsSnapshotSchema,
  type AccountCreditsSnapshot,
  type HarnessAccountUnavailableReason,
} from "@codexhost/shared-contracts";

/** Legacy caches can carry a private fetch timestamp; it is not quota presentation data. */
export function parseHarnessAccountCredits(value: unknown): AccountCreditsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const publicValue = { ...value } as Record<string, unknown>;
  delete publicValue.fetchedAt;
  const parsed = accountCreditsSnapshotSchema.safeParse(publicValue);
  return parsed.success ? parsed.data : null;
}

/** Safe account inspection outcome; Host only forwards the validated reason. */
export class HarnessAccountInspectionError extends Error {
  constructor(readonly accountUnavailableReason: HarnessAccountUnavailableReason) {
    super("Native account quota is unavailable");
  }
}
