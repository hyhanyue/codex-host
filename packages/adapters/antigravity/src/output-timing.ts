import type { AntigravityStepUpdateEvent } from "./stream-events.js";

/** Times streamed model steps within one Turn, using the CLI's receipt times and token counts. */
export class AntigravityOutputTiming {
  readonly #starts = new Map<number, number>();
  readonly #finished = new Set<number>();
  #outputTokens = 0;
  #outputTimeMs = 0;

  observe(
    step: AntigravityStepUpdateEvent["step_update"],
    receivedAtMs: number,
  ): number | undefined {
    if (step.step_type !== "agent_response") {
      if (
        step.step_type === "tool" ||
        step.step_type === "checkpoint" ||
        step.step_type === "subagent" ||
        step.step_type === "user_input"
      ) {
        // A response with no completion before other work has no usable interval.
        for (const index of this.#starts.keys()) this.#finished.add(index);
        this.#starts.clear();
      }
      return;
    }

    const index = step.step_index;
    if (!Number.isSafeInteger(index) || index < 0 || this.#finished.has(index)) return;
    if (step.state === "ACTIVE") {
      if (
        typeof step.text_delta === "string" &&
        step.text_delta.trim() &&
        !this.#starts.has(index)
      ) {
        this.#starts.set(index, receivedAtMs);
      }
      return;
    }
    if (step.state !== "DONE" && step.state !== "ERROR") return;

    const startedAtMs = this.#starts.get(index);
    this.#starts.delete(index);
    this.#finished.add(index);
    if (step.state !== "DONE" || startedAtMs === undefined) return;

    const tokens = step.usage?.output_tokens;
    const elapsedMs = receivedAtMs - startedAtMs;
    if (
      typeof tokens !== "number" ||
      !Number.isSafeInteger(tokens) ||
      tokens <= 0 ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs <= 0
    )
      return;

    this.#outputTokens += tokens;
    this.#outputTimeMs += elapsedMs;
    return (this.#outputTokens * 1000) / this.#outputTimeMs;
  }
}
