import { z } from "zod";

import {
  harnessInspectParamsSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  readyHarnessInspectionSchema,
} from "./harness-models.js";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

export const COMPOSER_DELEGATE_METHOD = "codexhost/thread/delegate/start";
export const DELEGATION_CATALOG_METHOD = "codexhost/thread/delegate/catalog";
export const HANDOFF_PREVIEW_METHOD = "codexhost/thread/handoff/preview";
export const HANDOFF_SEND_METHOD = "codexhost/thread/handoff/send";

const requestId = z.uuid();
const text = z
  .string()
  .max(1_000_000)
  .refine((value) => value.trim().length > 0);
const threadId = hostThreadIdSchema;
const harnessId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/u)
  .pipe(harnessIdSchema);

const delegationCatalogScope = {
  hostId: z.string().min(1).max(1_024),
  harnessId: z.literal("codex"),
  instanceId: z.string().min(1).max(1_024),
  revision: z.number().int().nonnegative(),
  action: z.enum(["snapshot", "refresh"]),
};
export const delegationCatalogParamsSchema = z.union([
  z.strictObject({ ...delegationCatalogScope, threadId }),
  z.strictObject({ ...delegationCatalogScope, cwd: harnessInspectParamsSchema.shape.cwd.unwrap() }),
]);
export const delegationCatalogResultSchema = readyHarnessInspectionSchema.nullable();
export type DelegationCatalogParams = z.infer<typeof delegationCatalogParamsSchema>;
export type DelegationCatalogResult = z.infer<typeof delegationCatalogResultSchema>;

const composerDelegateSelection = {
  harnessId,
  requestId,
  text,
  model: harnessModelRefSchema.optional(),
  thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
};

export const composerDelegateParamsSchema = z.union([
  z.strictObject({ ...composerDelegateSelection, threadId }),
  z.strictObject({ ...composerDelegateSelection, cwd: z.string().trim().min(1).max(16_384) }),
]);

export const composerDelegateResultSchema = z.object({ threadId });

export const handoffPreviewParamsSchema = z.strictObject({ threadId, harnessId });
export const handoffPreviewResultSchema = z.strictObject({
  summary: z.string(),
  revision: z.string().regex(/^[0-9a-f]{64}$/u),
});
export const handoffSendParamsSchema = handoffPreviewParamsSchema.extend({
  revision: handoffPreviewResultSchema.shape.revision,
  requestId,
  text,
});
export const handoffSendResultSchema = z.strictObject({ turnId: hostTurnIdSchema });

export type ComposerDelegateParams = z.infer<typeof composerDelegateParamsSchema>;
export type ComposerDelegateResult = z.infer<typeof composerDelegateResultSchema>;
export type HandoffPreviewParams = z.infer<typeof handoffPreviewParamsSchema>;
export type HandoffPreviewResult = z.infer<typeof handoffPreviewResultSchema>;
export type HandoffSendParams = z.infer<typeof handoffSendParamsSchema>;
export type HandoffSendResult = z.infer<typeof handoffSendResultSchema>;
