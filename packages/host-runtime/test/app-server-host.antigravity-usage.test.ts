import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AntigravityAdapter } from "@codexhost/adapter-antigravity";
import { encodeHarnessPluginRoute, threadUsageInspectionSchema } from "@codexhost/shared-contracts";
import { expect, it } from "vitest";
import {
  createFixture,
  requestId,
  startExternalThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

it.each(["streamed", "batched"] as const)(
  "reports Antigravity usage through the Host for %s output",
  async (delivery) => {
    const home = await mkdtemp(path.join(tmpdir(), "codexhost-agy-metrics-"));
    const script = path.join(home, "agy.cjs");
    const command = process.platform === "win32" ? path.join(home, "agy.cmd") : script;
    const conversationId = "conv-measurement";
    const step = (state: string, text: string, usage?: Record<string, number>) => ({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        step_type: "agent_response",
        state,
        text_delta: text,
        usage,
      },
    });
    const events = [
      { event: "init", conversation_id: conversationId },
      step("ACTIVE", "First"),
      step("DONE", " reply", { output_tokens: 30, thinking_tokens: 20 }),
      {
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          num_turns: 1,
          response: "First reply",
          usage: { output_tokens: 300 },
        },
      },
    ];
    const chunks = delivery === "streamed" ? events.map((event) => [event]) : [events];
    const adapter = new AntigravityAdapter({
      command,
      environment: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const fixture = createFixture({ additionalAdapters: new Map([[adapter.harnessId, adapter]]) });
    try {
      await writeFile(
        script,
        `#!/usr/bin/env node
const { setTimeout: wait } = require("node:timers/promises");
async function main() {
  if (process.argv.includes("models")) {
    process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
    return;
  }
  for (const chunk of ${JSON.stringify(chunks)}) {
    process.stdout.write(chunk.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
    await wait(30);
  }
}
void main();
`,
        { mode: 0o755 },
      );
      if (process.platform === "win32") {
        await writeFile(command, `@node "${script}" %*\r\n`);
      }
      const threadId = await startExternalThread(
        fixture,
        encodeHarnessPluginRoute({ harnessId: adapter.harnessId }),
        1,
        { cwd: home },
      );
      const turnId = await startPiTurn(fixture, threadId, 2);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/thread/usage/inspect",
        params: { threadId },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 3));
      const usage = threadUsageInspectionSchema.parse(response.result).usage;
      expect(usage?.outputTokens).toBe(300);
      expect(usage?.timeToFirstOutputMs).toBeGreaterThanOrEqual(0);
      if (delivery === "streamed") expect(usage?.outputTokensPerSecond).toBeGreaterThan(0);
      else expect(usage?.outputTokensPerSecond).toBeUndefined();
    } finally {
      try {
        await stopFixture(fixture);
      } finally {
        await adapter.close();
        await rm(home, { recursive: true, force: true });
      }
    }
  },
);
