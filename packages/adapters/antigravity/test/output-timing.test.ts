import { expect, it } from "vitest";
import { AntigravityOutputTiming } from "../src/output-timing.js";
import type { AntigravityStepUpdateEvent } from "../src/stream-events.js";

function response(
  index: number,
  state: string,
  fields: Partial<AntigravityStepUpdateEvent["step_update"]> = {},
): AntigravityStepUpdateEvent["step_update"] {
  return {
    conversation_id: "conversation",
    step_index: index,
    step_type: "agent_response",
    state,
    ...fields,
  };
}

it("counts each completed streamed step once and excludes tool waits and thinking double counts", () => {
  const timing = new AntigravityOutputTiming();
  expect(timing.observe(response(1, "ACTIVE", { text_delta: "First" }), 100)).toBeUndefined();
  expect(timing.observe(response(1, "ACTIVE", { text_delta: " reply" }), 150)).toBeUndefined();
  const done = response(1, "DONE", { usage: { output_tokens: 20, thinking_tokens: 15 } });
  expect(timing.observe(done, 300)).toBe(100);
  expect(timing.observe(done, 400)).toBeUndefined();
  timing.observe(response(2, "ACTIVE", { step_type: "tool" }), 400);
  timing.observe(response(2, "DONE", { step_type: "tool" }), 4800);
  timing.observe(response(3, "ACTIVE", { text_delta: "Second" }), 5000);
  expect(timing.observe(response(3, "DONE", { usage: { output_tokens: 80 } }), 5400)).toBeCloseTo(
    100 / 0.6,
  );
});

it("ignores incomplete steps, single-event replies, missing usage and interrupted timing", () => {
  const timing = new AntigravityOutputTiming();
  const report = { text_delta: "Reply", duration_seconds: 1, usage: { output_tokens: 20 } };
  expect(timing.observe(response(1, "DONE", report), 100)).toBeUndefined();
  timing.observe(response(1, "ACTIVE", { text_delta: "Late" }), 150);
  expect(timing.observe(response(1, "DONE", report), 200)).toBeUndefined();

  timing.observe(response(2, "ACTIVE", { text_delta: "Incomplete" }), 300);
  timing.observe(response(3, "ACTIVE", { step_type: "tool" }), 400);
  expect(timing.observe(response(2, "DONE", report), 4000)).toBeUndefined();

  timing.observe(response(4, "ACTIVE", { text_delta: "No usage" }), 4200);
  expect(timing.observe(response(4, "DONE"), 4300)).toBeUndefined();

  timing.observe(response(5, "ACTIVE", { text_delta: "Failed" }), 4400);
  expect(timing.observe(response(5, "ERROR", report), 4500)).toBeUndefined();
  expect(timing.observe(response(5, "DONE", report), 4600)).toBeUndefined();

  timing.observe(response(6, "ACTIVE", { text_delta: "Same timestamp" }), 4700);
  expect(timing.observe(response(6, "DONE", report), 4700)).toBeUndefined();

  timing.observe(response(7, "ACTIVE", { text_delta: "Valid" }), 5000);
  expect(timing.observe(response(7, "DONE", report), 5400)).toBe(50);
});
