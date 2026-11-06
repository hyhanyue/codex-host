import { describe, expect, it } from "vitest";
import { parseKiroAccountUsage } from "../src/account-usage.js";

describe("Kiro native account credits", () => {
  it("keeps the reported plan, quantities and date without inventing a reset time", () => {
    const output = [
      "\x1b[1mEstimated Usage | resets on 2026-12-01 | KIRO PRO\x1b[0m",
      "Credits (622.57 of 1,000 covered in plan), 62.3%",
      "Overages: Disabled",
    ].join("\n");
    expect(parseKiroAccountUsage(output)).toMatchObject({
      plan: "KIRO PRO",
      credits: {
        periodType: "monthly",
        used: 622.57,
        limit: 1000,
        usedPercent: expect.closeTo(62.257),
        unit: "credits",
        resetsAt: "2026-12-01",
      },
    });
  });

  it("requires a reported allowance and ignores session metering and invalid reset dates", () => {
    expect(parseKiroAccountUsage('{"unit":"credit","usage":0.4}')).toBeNull();
    expect(parseKiroAccountUsage("Estimated Usage | KIRO PRO\nCredits (8 used), 80%")).toBeNull();
    const result = parseKiroAccountUsage(
      "Estimated Usage | resets on 2026-02-30 | KIRO PRO\nCredits (0 of 50 covered in plan), 0%",
    );
    expect(result?.credits?.usedPercent).toBe(0);
    expect(result?.credits?.resetsAt).toBeUndefined();
  });
});
