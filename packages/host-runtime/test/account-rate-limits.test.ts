import { describe, expect, it, vi } from "vitest";
import { AccountRateLimits } from "../src/codex-runtime/account-rate-limits.js";
import type { JsonObject } from "@codexhost/protocol-core";

const response = (usedPercent: number): JsonObject => ({
  result: { rateLimits: { primary: { usedPercent, windowDurationMins: 300 } } },
});

describe("Account quota cache", () => {
  it("isolates concurrent reads and deduplicates only within an Account", async () => {
    const cache = new AccountRateLimits();
    const pending = Promise.withResolvers<JsonObject>();
    const readA = vi.fn(() => pending.promise);
    const first = cache.refresh("a", readA);
    expect(cache.refresh("a", readA)).toBe(first);
    await cache.refresh("b", async () => response(80));
    pending.resolve(response(20));
    await first;
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(20);
    expect(cache.get("b")?.planFiveHourUsedPercent).toBe(80);
    await cache.refresh("a", readA);
    expect(readA).toHaveBeenCalledTimes(1);
  });

  it("discards a response after that Account changes and preserves other Accounts", async () => {
    const cache = new AccountRateLimits();
    const pending = Promise.withResolvers<JsonObject>();
    const old = cache.refresh("a", () => pending.promise);
    await cache.refresh("b", async () => response(80));
    cache.reset("a");
    await cache.refresh("a", async () => response(10));
    pending.resolve(response(95));
    await old;
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(10);
    expect(cache.get("b")?.planFiveHourUsedPercent).toBe(80);
  });

  it("invalidates only the notifying Account while keeping pulls authoritative", async () => {
    const cache = new AccountRateLimits();
    await cache.refresh("a", async () => response(20));
    await cache.refresh("b", async () => response(80));
    cache.observe("a", { planFiveHourUsedPercent: 99 });
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(20);
    const read = vi.fn(async () => response(30));
    await cache.refresh("a", read);
    await cache.refresh("b", read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(30);
    expect(cache.get("b")?.planFiveHourUsedPercent).toBe(80);
  });

  it("keeps only the windows returned by the latest successful account read", async () => {
    const cache = new AccountRateLimits();
    await cache.refresh("a", async () => response(20));
    await cache.refresh(
      "a",
      async () => ({
        rateLimits: {
          primary: { usedPercent: 43, windowDurationMins: 10_080, resetsAt: 1_794_386_706 },
          secondary: { usedPercent: 10, windowDurationMins: 720 },
        },
      }),
      true,
    );
    expect(cache.get("a")?.planFiveHourUsedPercent).toBeUndefined();
    expect(cache.getCredits("a")).toEqual({
      usedPercent: 43,
      periodType: "seven_day",
      resetsAt: "2026-11-11T08:45:06.000Z",
      productUsage: [{ product: "12-hour window", usagePercent: 10, periodType: "unknown" }],
    });
    await expect(cache.refresh("a", async () => ({ rateLimits: {} }), true)).resolves.toMatchObject(
      {
        status: "empty",
      },
    );
    expect(cache.getCredits("a")).toBeNull();
  });

  it("keeps reset-card inventory on the same Account snapshot as quota windows", async () => {
    const cache = new AccountRateLimits();
    await cache.refresh("a", async () => ({
      result: {
        rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300 } },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "soon",
              status: "available",
              expiresAt: 2_400,
            },
          ],
        },
      },
    }));
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(90);
    expect(cache.getResetCredits("a")).toEqual({
      availableCount: 2,
      nextExpiresAtUnix: 2_400,
      expiresAtUnix: [2_400],
    });
    cache.reset("a");
    expect(cache.getResetCredits("a")).toBeNull();
  });
});
