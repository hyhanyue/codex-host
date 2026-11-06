import { randomUUID } from "node:crypto";
import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  COMPOSER_DELEGATE_METHOD,
  HANDOFF_PREVIEW_METHOD,
  HANDOFF_SEND_METHOD,
  harnessIdSchema,
  harnessModelCatalogSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { expect, it } from "vitest";

import {
  closeFixture,
  createFixture,
  messageParams,
  requestId,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const threadId = "original-codex-thread";
const cwd = "/synthetic";
const codexTurn = {
  id: "codex-first-turn",
  status: "completed",
  items: [
    {
      id: "original-prompt",
      type: "userMessage",
      content: [{ type: "text", text: "Investigate retries" }],
    },
    { id: "original-response", type: "agentMessage", text: "Found missing retry coverage." },
  ],
};

const catalog = harnessModelCatalogSchema.parse({
  models: [
    { ref: { id: "alpha" }, label: "Alpha", supportedThinkingOptionIds: ["low"] },
    { ref: { id: "beta" }, label: "Beta", supportedThinkingOptionIds: ["high"] },
  ],
  defaultModel: { id: "alpha" },
  thinkingOptions: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  defaultThinkingOptionId: "low",
});

class RecordingAdapter extends FakeHarnessAdapter {
  readonly opens: Parameters<FakeHarnessAdapter["open"]>[0][] = [];
  reject = false;
  restore: HostThreadSnapshot | undefined;
  delayedIdentity = false;

  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    this.opens.push(input);
    if (input.kind === "resume" && this.restore) {
      const session = new FakeHarnessSession(
        this.harnessId,
        this.catalog,
        input.model,
        input.nativeRef,
        this.restore,
      );
      this.sessions.push(session);
      return { ok: true as const, value: session };
    }
    const result = await super.open(input);
    if (result.ok && result.value instanceof FakeHarnessSession) {
      const session = result.value;
      if (this.reject) {
        session.rejectNextTurn({
          code: "nativeFailure",
          message: "Target refused",
          retryable: true,
        });
      } else if (this.delayedIdentity) {
        const { nativeRef, ...initial } = session.initialState;
        Object.defineProperty(session, "initialState", { value: initial });
        if (nativeRef)
          session.emitEvent({ type: "session.state.changed", state: { ...initial, nativeRef } });
      }
    }
    return result;
  }
}

function firstSession(adapter: RecordingAdapter): FakeHarnessSession {
  const session = adapter.sessions[0];
  if (!session) throw new Error("Expected a target Harness Session");
  return session;
}

function fixture(adapter: RecordingAdapter, mappingStoreDirectory?: string, paginated = false) {
  const target = adapter.harnessId === "claude-code" ? "claude-code" : "pi";
  const value = createFixture({
    externalAdapters: new Map([[target, adapter]]),
    ...(mappingStoreDirectory ? { mappingStoreDirectory } : {}),
  });
  let active = false;
  let queued = false;
  let turns: JsonObject[] = [codexTurn];
  const native: JsonObject[] = [];
  const thread = {
    id: threadId,
    name: "Original title",
    cwd,
    preview: "Investigate retries",
    createdAt: 100,
    updatedAt: 101,
    modelProvider: "openai",
    source: "vscode",
    historyMode: paginated ? "paginated" : "legacy",
  };
  value.official.stdin.setEncoding("utf8");
  let buffer = "";
  value.official.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const request = JSON.parse(buffer.slice(0, newline)) as JsonObject;
      buffer = buffer.slice(newline + 1);
      native.push(request);
      if (request.id === undefined) continue;
      const result =
        request.method === "thread/read"
          ? {
              thread: {
                ...thread,
                status: { type: active ? "active" : "idle" },
                turns: messageParams(request).includeTurns ? turns : [],
              },
            }
          : request.method === "thread/turns/list"
            ? { data: turns, nextCursor: null }
            : request.method === "thread/queue/list"
              ? { data: queued ? [{ id: "queued-input" }] : [], nextCursor: null }
              : request.method === "thread/list"
                ? { data: [thread], nextCursor: null, backwardsCursor: null }
                : { userAgent: "test", turn: { id: "native-turn" } };
      writeRequest(value.official.stdout, { id: request.id, result });
    }
  });

  let id = 0;
  return {
    ...value,
    native,
    setBusy(busy: boolean) {
      active = busy;
    },
    setQueued(value: boolean) {
      queued = value;
    },
    appendTurn(turn: JsonObject) {
      turns = [...turns, turn];
    },
    async request(method: string, params: JsonObject) {
      await value.ready;
      const current = ++id;
      writeRequest(value.desktopInput, { id: current, method, params });
      return value.collector.waitFor((message) => requestId(message, current));
    },
  };
}

it.each(["claude-code", "pi"])(
  "hands Codex off to %s in the same Thread and restores its route",
  async (target) => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse(target), catalog);
    adapter.delayedIdentity = true;
    const value = fixture(adapter, undefined, target === "claude-code");
    let restarted: ReturnType<typeof fixture> | undefined;
    try {
      const preview = await value.request(HANDOFF_PREVIEW_METHOD, { threadId, harnessId: target });
      expect(preview.result).toMatchObject({
        summary: expect.stringContaining("Found missing retry coverage."),
      });
      expect(adapter.opens).toHaveLength(0);
      const input = {
        threadId,
        harnessId: target,
        requestId: randomUUID(),
        revision: (preview.result as JsonObject).revision ?? null,
        text: "Add the test.",
      };
      const [accepted, repeated] = await Promise.all([
        value.request(HANDOFF_SEND_METHOD, input),
        value.request(HANDOFF_SEND_METHOD, input),
      ]);
      expect(accepted.result).toMatchObject({ turnId: expect.any(String) });
      expect(repeated.result).toEqual(accepted.result);
      expect(adapter.opens).toEqual([expect.objectContaining({ kind: "create", cwd })]);
      expect(adapter.opens[0]).not.toHaveProperty("executionPolicy");
      expect(
        await value.request(HANDOFF_SEND_METHOD, { ...input, requestId: randomUUID() }),
      ).toHaveProperty("error");
      const turnId = String((accepted.result as JsonObject).turnId);
      await value.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = firstSession(adapter);
      session.appendText("Test added.");
      session.succeedTurn();
      await value.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      expect(JSON.stringify(session.persistedSnapshot())).toContain(
        "Found missing retry coverage.",
      );
      const list = await value.request("thread/list", {});
      expect(list.result).toMatchObject({
        data: [{ id: threadId, name: "Original title", modelProvider: "codexhost" }],
      });
      const record = await value.mappingStore.getThreadByCreateRequest(
        `handoff:${threadId}:${input.requestId}`,
      );
      expect(record).toMatchObject({
        hostThreadId: threadId,
        harnessId: target,
        nativeSessionRef: { harnessId: target },
      });
      await closeFixture(value);

      const restoredAdapter = new RecordingAdapter(harnessIdSchema.parse(target), catalog);
      restoredAdapter.restore = session.persistedSnapshot();
      restarted = fixture(restoredAdapter, value.mappingStoreDirectory, target === "claude-code");
      const read = await restarted.request("thread/resume", { threadId });
      const turns = ((read.result as JsonObject).thread as JsonObject).turns as JsonObject[];
      expect(turns).toHaveLength(3);
      expect(turns[0]).toEqual(codexTurn);
      expect(turns[1]).toMatchObject({
        items: [{ text: expect.stringContaining("Agent handoff · Codex →") }],
      });
      expect(turns[2]?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "userMessage",
            content: [{ type: "text", text: "Add the test.", text_elements: [] }],
          }),
          expect.objectContaining({ type: "agentMessage", text: "Test added." }),
        ]),
      );
      const next = await restarted.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Now review it." }],
      });
      expect(next).toHaveProperty("result.turn.id");
      expect(restarted.native.some((message) => message.method === "turn/start")).toBe(false);
      const resumed = firstSession(restoredAdapter);
      resumed.succeedTurn();
      expect((await restarted.request(HANDOFF_SEND_METHOD, input)).result).toEqual(accepted.result);
    } finally {
      await stopFixture(restarted ?? value);
    }
  },
);

it("refuses busy and stale handoffs and keeps the Codex route if the target rejects", async () => {
  const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), catalog);
  adapter.reject = true;
  const value = fixture(adapter);
  try {
    const target = { threadId, harnessId: "pi" };
    const preview = await value.request(HANDOFF_PREVIEW_METHOD, target);
    const input = {
      ...target,
      requestId: randomUUID(),
      revision: (preview.result as JsonObject).revision ?? null,
      text: "Keep this draft.",
    };
    value.setBusy(true);
    expect(await value.request(HANDOFF_SEND_METHOD, input)).toMatchObject({
      error: { message: expect.stringContaining("active") },
    });
    value.setBusy(false);
    value.setQueued(true);
    expect(await value.request(HANDOFF_SEND_METHOD, input)).toMatchObject({
      error: { message: expect.stringContaining("queued Codex messages") },
    });
    value.setQueued(false);
    value.appendTurn({ ...codexTurn, id: "new-source-turn" });
    expect(await value.request(HANDOFF_SEND_METHOD, input)).toMatchObject({
      error: { message: expect.stringContaining("history changed") },
    });
    expect(adapter.opens).toHaveLength(0);
    const refreshed = await value.request(HANDOFF_PREVIEW_METHOD, target);
    expect(
      await value.request(HANDOFF_SEND_METHOD, {
        ...input,
        revision: (refreshed.result as JsonObject).revision ?? null,
      }),
    ).toMatchObject({ error: { message: "Target refused" } });
    expect(await value.request("codexhost/thread/inspect", { threadId })).toMatchObject({
      result: { owner: "codex" },
    });
    expect(
      (await value.request("turn/start", { threadId, input: [{ type: "text", text: input.text }] }))
        .result,
    ).toMatchObject({ turn: { id: "native-turn" } });
  } finally {
    await stopFixture(value);
  }
});

it("starts a separate delegated Thread with validated model and thinking on its first Turn", async () => {
  const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), catalog);
  const value = fixture(adapter);
  try {
    const target = { threadId, harnessId: "pi" };
    expect(await value.request("codexhost/harness/inspect", target)).toMatchObject({
      result: { catalog },
    });
    const input = {
      ...target,
      requestId: randomUUID(),
      text: "Run the checks.",
      model: { id: "beta" },
      thinkingOptionId: "high",
    };
    expect(
      await value.request(COMPOSER_DELEGATE_METHOD, { ...input, thinkingOptionId: "low" }),
    ).toMatchObject({
      error: { message: expect.stringContaining("unavailable for the selected Model") },
    });
    expect(adapter.opens).toHaveLength(0);
    const [accepted, repeated] = await Promise.all([
      value.request(COMPOSER_DELEGATE_METHOD, input),
      value.request(COMPOSER_DELEGATE_METHOD, input),
    ]);
    expect(accepted.result).toMatchObject({ threadId: expect.any(String) });
    expect(repeated.result).toEqual(accepted.result);
    const childId = String((accepted.result as JsonObject).threadId);
    expect(childId).not.toBe(threadId);
    expect(adapter.opens).toEqual([
      expect.objectContaining({
        kind: "create",
        cwd,
        model: { id: "beta" },
        thinkingOptionId: "high",
        requireExactConfiguration: true,
      }),
    ]);
    expect(adapter.opens[0]).not.toHaveProperty("executionPolicy");
    expect(await value.request("codexhost/thread/inspect", { threadId: childId })).toMatchObject({
      result: {
        harnessId: "pi",
        effectiveModel: { id: "beta" },
        effectiveThinkingOptionId: "high",
      },
    });
    expect(await value.request("codexhost/thread/inspect", { threadId })).toMatchObject({
      result: { owner: "codex" },
    });
    firstSession(adapter).succeedTurn();
    await value.collector.waitFor(
      (message) =>
        message.method === "turn/completed" && messageParams(message).threadId === childId,
    );
    expect(JSON.stringify(firstSession(adapter).persistedSnapshot())).toContain(input.text);
  } finally {
    await stopFixture(value);
  }
});

it("starts a configured first Turn from a new draft without requiring a parent", async () => {
  const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), catalog);
  const value = fixture(adapter);
  try {
    const input = {
      cwd,
      harnessId: "pi",
      requestId: randomUUID(),
      text: "Start in the selected workspace.",
      model: { id: "beta" },
      thinkingOptionId: "high",
    };
    const [first, retry] = await Promise.all([
      value.request(COMPOSER_DELEGATE_METHOD, input),
      value.request(COMPOSER_DELEGATE_METHOD, input),
    ]);
    expect(first.result).toMatchObject({ threadId: expect.any(String) });
    expect(retry.result).toEqual(first.result);
    expect(adapter.opens).toEqual([
      expect.objectContaining({
        cwd,
        model: { id: "beta" },
        thinkingOptionId: "high",
        requireExactConfiguration: true,
      }),
    ]);
    const started = String((first.result as JsonObject).threadId);
    firstSession(adapter).succeedTurn();
    await value.collector.waitFor(
      (message) =>
        message.method === "turn/completed" && messageParams(message).threadId === started,
    );
    expect(JSON.stringify(firstSession(adapter).persistedSnapshot())).toContain(input.text);
  } finally {
    await stopFixture(value);
  }
});
