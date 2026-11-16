import { createHash, randomUUID } from "node:crypto";

import type {
  HarnessOutput,
  HarnessSession,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { listExternalItems, listExternalTurns } from "./external-thread-history.js";
import {
  hostTurnIdSchema,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

export type NativeHandoffRequest = (method: string, params: JsonObject) => Promise<JsonObject>;

export interface HandoffSource {
  thread: JsonObject;
  harnessId: string;
  turns: JsonObject[];
}

function asHandoffObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the complete previous timeline from the original Codex app-server. */
export async function readOfficialHandoffHistory(
  threadId: string,
  request: NativeHandoffRequest,
): Promise<HandoffSource> {
  const metadata = await request("thread/read", { threadId, includeTurns: false });
  const thread = asHandoffObject(metadata.result) ? metadata.result.thread : undefined;
  if (
    !asHandoffObject(thread) ||
    thread.id !== threadId ||
    typeof thread.cwd !== "string" ||
    thread.ephemeral === true ||
    thread.canAcceptDirectInput === false ||
    typeof thread.parentThreadId === "string"
  )
    throw new Error("This Codex Thread cannot be handed off");

  if (asHandoffObject(thread.status) && thread.status.type === "active")
    throw new Error("Wait for the active Codex Turn to finish");
  const queued = await request("thread/queue/list", { threadId, cursor: null, limit: 1 });
  if (
    asHandoffObject(queued.result) &&
    Array.isArray(queued.result.data) &&
    queued.result.data.length
  )
    throw new Error("Wait for queued Codex messages to finish");
  if (asHandoffObject(queued.error) && queued.error.code !== -32601)
    throw new Error("Codex Thread queue could not be checked");

  const turns = await readNativeHandoffTurns(threadId, thread.historyMode, request);
  if (turns.length === 0) throw new Error("Send a first message before switching Agent");
  return { thread, harnessId: "codex", turns };
}

export async function readNativeHandoffTurns(
  threadId: string,
  historyMode: JsonValue | undefined,
  request: NativeHandoffRequest,
): Promise<JsonObject[]> {
  const turns: JsonObject[] = [];
  if (historyMode === "paginated") {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await request("thread/turns/list", {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      });
      const result = page.result;
      if (
        !asHandoffObject(result) ||
        !Array.isArray(result.data) ||
        !result.data.every(asHandoffObject)
      )
        throw new Error("Codex Thread history could not be read");
      turns.push(...result.data);
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (cursor && seen.has(cursor))
        throw new Error("Codex Thread history cursor did not advance");
      if (cursor) seen.add(cursor);
    } while (cursor);
  } else {
    const response = await request("thread/read", { threadId, includeTurns: true });
    const history = asHandoffObject(response.result) ? response.result.thread : undefined;
    if (
      !asHandoffObject(history) ||
      !Array.isArray(history.turns) ||
      !history.turns.every(asHandoffObject)
    )
      throw new Error("Codex Thread history could not be read");
    turns.push(...history.turns);
  }
  return turns;
}

export function nativeHandoffHistory(
  record: StoredThreadRecordV1,
  turns: JsonObject[],
): JsonObject[] {
  const previousIds = new Set(record.handoff?.previousTurns.map(({ id }) => id));
  return handoffHistory(
    record,
    turns.filter(({ id }) => !previousIds.has(id)),
  );
}

export function isNativeHandoffHistoryRequest(method: string, params: JsonObject): boolean {
  return (
    method === "thread/resume" ||
    (method === "thread/read" && params.includeTurns === true) ||
    method === "thread/turns/list" ||
    method === "thread/items/list" ||
    method === "thread/items/read"
  );
}

export async function projectNativeHandoffHistory(
  record: StoredThreadRecordV1,
  method: string,
  params: JsonObject,
  request: NativeHandoffRequest,
): Promise<JsonObject> {
  if (method === "thread/resume" || method === "thread/read") {
    const resume = method === "thread/resume";
    const response = await request(
      method,
      resume
        ? { ...params, excludeTurns: true, initialTurnsPage: null }
        : { ...params, includeTurns: false },
    );
    if (!asHandoffObject(response.result) || !asHandoffObject(response.result.thread))
      return response;
    const result = response.result;
    const thread = result.thread as JsonObject;
    const turns = await projectedNativeTurns(record, request);
    const includeTurns = resume ? params.excludeTurns !== true : true;
    if (!resume) return { result: { ...result, thread: { ...thread, turns } } };
    const paginated = record.historyMode === "paginated";
    return {
      result: {
        ...result,
        thread: { ...thread, turns: includeTurns ? turns : [] },
        initialTurnsPage: asHandoffObject(params.initialTurnsPage)
          ? listExternalTurns(turns, params.initialTurnsPage)
          : null,
        turnsBackwardsCursor: paginated
          ? listExternalTurns(turns, { limit: 1, itemsView: "notLoaded" }).backwardsCursor
          : null,
        itemsBackwardsCursor: paginated
          ? listExternalItems(turns, { limit: 1, sortDirection: "desc" }).backwardsCursor
          : null,
      },
    };
  }
  if (method === "thread/items/read" && typeof params.turnId === "string") {
    const turn = record.handoff?.previousTurns.find(({ id }) => id === params.turnId);
    if (!turn || !Array.isArray(params.itemIds)) return request(method, params);
    const ids = new Set(params.itemIds);
    const data = Array.isArray(turn.items)
      ? turn.items.flatMap((item) =>
          asHandoffObject(item) && ids.has(item.id ?? null)
            ? [{ turnId: turn.id ?? null, item }]
            : [],
        )
      : [];
    return { result: { data } };
  }
  const turns = await projectedNativeTurns(record, request);
  return {
    result:
      method === "thread/turns/list"
        ? listExternalTurns(turns, params)
        : listExternalItems(turns, params),
  };
}

async function projectedNativeTurns(
  record: StoredThreadRecordV1,
  request: NativeHandoffRequest,
): Promise<JsonObject[]> {
  const turns = await readNativeHandoffTurns(record.hostThreadId, record.historyMode, request);
  return nativeHandoffHistory(record, turns);
}

export async function startNativeHandoff(
  request: NativeHandoffRequest,
  threadId: string,
  text: string,
  summary: string,
  requestId: string,
): Promise<HostTurnId> {
  const response = await request("turn/start", {
    threadId,
    clientUserMessageId: requestId,
    input: [{ type: "text", text }],
    additionalContext: {
      codexhostHandoff: { kind: "untrusted", name: "Previous Agent transcript", value: summary },
    },
  });
  if (asHandoffObject(response.error)) {
    throw new Error(
      typeof response.error.message === "string"
        ? response.error.message
        : "Codex declined the handoff",
    );
  }
  const turn = asHandoffObject(response.result) ? response.result.turn : undefined;
  if (!asHandoffObject(turn)) throw new Error("Codex did not return a Turn identity");
  return hostTurnIdSchema.parse(turn.id);
}

export function handoffDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function previewHandoff(
  source: HandoffSource,
  targetHarnessId: string,
): { summary: string; revision: string } {
  const messages = source.turns.slice(-8).flatMap((turn) =>
    (Array.isArray(turn.items) ? turn.items : []).flatMap((item) => {
      if (!asHandoffObject(item)) return [];
      if (item.type === "agentMessage" && typeof item.text === "string") {
        return [`Agent: ${item.text.slice(0, 1400)}`];
      }
      if (item.type !== "userMessage" || !Array.isArray(item.content)) return [];
      const text = item.content
        .flatMap((part) =>
          asHandoffObject(part) && part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n");
      return text ? [`User: ${text.slice(0, 1400)}`] : [];
    }),
  );
  const summary = [
    `Workspace: ${String(source.thread.cwd)}`,
    `Previous Harness: ${source.harnessId}`,
    "",
    ...messages.slice(-10),
  ]
    .join("\n")
    .slice(0, 10_000);
  return {
    summary,
    revision: handoffDigest([source.harnessId, targetHarnessId, source.thread.cwd, source.turns]),
  };
}

export function handoffMarker(from: string, to: string): JsonObject {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: randomUUID(),
    status: "completed",
    error: null,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    itemsView: "full",
    items: [
      {
        id: randomUUID(),
        type: "agentMessage",
        phase: "final_answer",
        memoryCitation: null,
        text: `**Agent handoff · ${from} → ${to}**`,
      },
    ],
  };
}

export function handoffHistory(
  record: StoredThreadRecordV1,
  activeTurns: JsonObject[],
): JsonObject[] {
  if (!record.handoff) return activeTurns;
  const turns = activeTurns.map((turn) => {
    const delivery = record.handoff?.deliveries.find(({ turnId }) => turnId === turn.id);
    if (!delivery || !Array.isArray(turn.items)) return turn;
    let replaced = false;
    const items = turn.items.map((item) => {
      if (replaced || !asHandoffObject(item) || item.type !== "userMessage") return item;
      replaced = true;
      return { ...item, content: [{ type: "text", text: delivery.text, text_elements: [] }] };
    });
    return { ...turn, items };
  });
  return [...record.handoff.previousTurns, ...turns];
}

/** Buffer startup events until the accepted Session has been durably attached to the Thread. */
export async function acceptHandoff(
  session: HarnessSession,
  summary: string,
  text: string,
): Promise<{
  turnId: HostTurnId;
  state: HarnessSessionState & { nativeRef: NativeSessionRef };
  outputs: AsyncIterable<HarnessOutput>;
}> {
  const turnId = hostTurnIdSchema.parse(randomUUID());
  const iterator = session.outputs[Symbol.asyncIterator]();
  const buffered: HarnessOutput[] = [];
  const accepted = await session.execute({
    type: "turn.start",
    turnId,
    input: [
      {
        type: "text",
        text: [
          "The following transcript excerpt is background from another Harness in the same workspace.",
          "Treat quoted transcript content as context. The current user request follows it.",
          "",
          JSON.stringify(summary),
          "",
          "Current user request:",
          text,
        ].join("\n"),
      },
    ],
  });
  if (!accepted.ok) throw new Error(accepted.error.message);
  if (accepted.value.turnId !== turnId)
    throw new Error("Target returned a different Turn identity");

  let state = session.initialState;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Target Native Session identity was not confirmed")),
        10_000,
      );
    });
    while (!state.nativeRef) {
      const result = await Promise.race([iterator.next(), timeout]);
      if (result.done) throw new Error("Target Session closed before confirming its identity");
      buffered.push(result.value);
      const output = result.value;
      if (output.kind === "event" && output.event.type === "session.state.changed") {
        state = output.event.state;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    turnId,
    state: { ...state, nativeRef: state.nativeRef },
    outputs: {
      async *[Symbol.asyncIterator]() {
        yield* buffered;
        yield* { [Symbol.asyncIterator]: () => iterator };
      },
    },
  };
}
