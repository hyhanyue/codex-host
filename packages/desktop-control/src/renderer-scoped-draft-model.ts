import { committedReactAncestors } from "./renderer-react-ownership.js";

type Draft = Record<string, unknown>;
type UpdateDraft = (update: (current: Draft) => Draft) => void;
interface DraftElement {
  parentElement: DraftElement | null;
  querySelector?(selector: string): DraftElement | null;
}
interface ScopedDraftModelBinding {
  update: UpdateDraft;
  usesAccountPreferences: boolean;
  creationModes?: readonly Draft[];
}

/** Versioned Desktop memo tuples bind the client Thread identity, draft setter
 * and current Model settings mode. Never use the official default Model setter.
 */
export function findScopedDraftModelBinding(
  composer: DraftElement,
  draftId: string,
): ScopedDraftModelBinding | null {
  let element: DraftElement | null =
    composer.querySelector?.('[data-codex-composer], [contenteditable="true"][role="textbox"]') ??
    composer;
  let fiber: unknown;
  while (element && !fiber) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) fiber = Object.getOwnPropertyDescriptor(element, key)?.value;
    element = element.parentElement;
  }
  const rows: unknown[][] = [];
  const groups = new Map<unknown[], unknown[][]>();
  const draftRows = new Set<unknown[]>();
  const updates = new Set<UpdateDraft>();
  for (const ancestor of committedReactAncestors(fiber)) {
    const queue = ancestor.updateQueue as { memoCache?: { data?: unknown[] } } | null;
    const data = (queue?.memoCache?.data ?? []).filter(Array.isArray);
    for (const row of data) {
      rows.push(row);
      groups.set(row, data);
      if (!Array.isArray(row) || row.length !== 14 || row[6] !== draftId || row[7] !== draftId)
        continue;
      const result = row[13] as {
        draftSettings?: unknown;
        isNewThreadDraft?: unknown;
        updateDraftSettings?: unknown;
      } | null;
      if (
        result?.isNewThreadDraft === true &&
        row[11] === true &&
        result.draftSettings === row[10] &&
        result.updateDraftSettings === row[9] &&
        row[9] === row[12] &&
        typeof row[9] === "function"
      ) {
        draftRows.add(row);
        updates.add(row[9] as UpdateDraft);
      }
    }
  }
  let update: UpdateDraft | undefined;
  const modes = new Set<boolean>();
  const creationModes = new Set<Draft>();
  for (const row of rows) {
    if (row.length !== 24 && row.length !== 25 && row.length !== 37) continue;
    let setter: UpdateDraft;
    let accountMode: unknown;
    let result: Draft | null;
    const group = groups.get(row);
    const rowIndex = group?.indexOf(row) ?? -1;
    const candidate = group?.[rowIndex - 1];
    if (row.length === 37) {
      // Desktop 26.1117 separates the public Model hook from its settings context.
      // Its draft-only setter closes over the same updater as the nested draft hook.
      const draft = group?.[rowIndex + 1];
      setter = row[24] as UpdateDraft;
      accountMode = row[25];
      result = row[36] as Draft | null;
      if (
        row[16] !== null ||
        row[21] !== true ||
        !draft ||
        !draftRows.has(draft) ||
        draft[9] !== setter ||
        typeof row[27] !== "function" ||
        row[27] !== row[33] ||
        result?.setModelAndReasoningEffort !== row[27] ||
        result.modelSettings !== row[32]
      )
        continue;
    } else {
      // Desktop 26.1106 adds a next-turn setter before the draft setter.
      const shift = row.length === 25 ? 1 : 0;
      if (row[7] !== null || row[10 + shift] !== true) continue;
      const context = row[12 + shift] as Draft | null;
      setter = row[13 + shift] as UpdateDraft;
      accountMode = context?.usesAccountPreferences;
      result = row[23 + shift] as Draft | null;
      if (
        context !== row[21 + shift] ||
        typeof row[14 + shift] !== "function" ||
        row[14 + shift] !== row[20 + shift] ||
        result?.setModelAndReasoningEffort !== row[14 + shift]
      )
        continue;
    }
    if (
      !updates.has(setter) ||
      typeof accountMode !== "boolean" ||
      result?.usesAccountPreferences !== accountMode
    )
      continue;

    // Each native hook can create its own setter for the same draft atom.
    // Bind through the reviewed draft identity and require a single settings mode.
    update ??= setter;
    modes.add(accountMode);
    // Background creation receives a new client Thread id. Its collaboration mode
    // retains the originating draft's Model settings.
    const settings = result.modelSettings as Draft | null;
    const modeShift = candidate?.length === 55 ? 3 : 0;
    const mode = candidate?.[44 + modeShift] as Draft | null;
    const value = candidate?.[51 + modeShift] as Draft | null;
    if (
      (candidate?.length === 52 || candidate?.length === 55) &&
      settings &&
      candidate[39 + modeShift] === settings.model &&
      candidate[40 + modeShift] === settings.reasoningEffort &&
      mode &&
      mode === candidate[49 + modeShift] &&
      mode.settings === candidate[41 + modeShift] &&
      (mode.settings as Draft | null)?.model === settings.model &&
      value?.activeMode === mode
    )
      creationModes.add(mode);
  }
  const [usesAccountPreferences] = modes;
  return update && modes.size === 1 && usesAccountPreferences !== undefined
    ? {
        update,
        usesAccountPreferences,
        ...(creationModes.size ? { creationModes: [...creationModes] } : {}),
      }
    : null;
}

export function createScopedDraftModelWriter() {
  /** Only carriers the native setter accepted; `original` is the draft before the first one. */
  const captured = new Map<string, { update: UpdateDraft; original?: Draft; model: string }>();
  const restore = (key: string): void => {
    const entry = captured.get(key);
    if (!entry) return;
    entry.update((current) => {
      // Earlier queued writes capture the native settings before this updater runs.
      const { original } = entry;
      if (!original) return current;
      const settings = current.modelSettings as Draft | null;
      return settings?.model === entry.model && current.modelSettingsPersistAsDefault === false
        ? {
            ...current,
            modelSettings: original.modelSettings,
            modelSettingsPersistAsDefault: original.modelSettingsPersistAsDefault,
            isManuallyChanged: original.isManuallyChanged,
          }
        : current;
    });
    captured.delete(key);
  };
  return {
    has(key: string): boolean {
      return captured.has(key);
    },
    /** The carrier last written to this draft, or null while it keeps its native setting. */
    model(key: string): string | null {
      return captured.get(key)?.model ?? null;
    },
    apply(key: string, binding: ScopedDraftModelBinding, model: string | null): void {
      if (model === null) {
        restore(key);
        return;
      }
      const { update, usesAccountPreferences } = binding;
      const previous = captured.get(key);
      const entry: { update: UpdateDraft; original?: Draft; model: string } = { update, model };
      update((current) => {
        // Earlier queued writes may capture the native settings after apply() returns.
        entry.original ??= previous?.original ?? current;
        const settings = current.modelSettings as Draft | null;
        if (
          settings?.model === model &&
          settings.usesAccountPreferences === usesAccountPreferences &&
          current.modelSettingsPersistAsDefault === false
        )
          return current;
        return {
          ...current,
          isManuallyChanged: true,
          modelSettingsPersistAsDefault: false,
          modelSettings: {
            ...settings,
            model,
            reasoningEffort: settings?.reasoningEffort ?? null,
            profile: settings?.profile ?? null,
            usesAccountPreferences,
          },
        };
      });
      // A setter can evaluate the updater and still reject the commit; record the carrier only
      // after it returns, so a later rollback names what the draft actually holds.
      captured.set(key, entry);
    },
    dispose(): void {
      for (const key of captured.keys()) restore(key);
    },
  };
}
