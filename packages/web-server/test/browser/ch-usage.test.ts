import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ThreadUsageSnapshot } from "@codexhost/shared-contracts";
import { chromium } from "playwright";

import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

const cases: Array<{
  name: string;
  usage: ThreadUsageSnapshot;
  latest: string;
  average: string;
}> = [
  {
    name: "unknown-cache-buckets",
    usage: {
      inputTokens: 144_252,
      outputTokens: 32_294,
      cacheHitRatePercent: 99.51685747295453,
      sessionCacheHitRatePercent: 97.56966586569621,
    },
    latest: "99.5%",
    average: "97.6%",
  },
  {
    name: "known-zero-cache",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 40,
      cacheHitRatePercent: 0,
      sessionCacheHitRatePercent: 0,
    },
    latest: "0%",
    average: "0%",
  },
  {
    name: "known-cache-buckets",
    usage: {
      inputTokens: 1_000,
      cachedInputTokens: 900,
      cacheWriteInputTokens: 0,
      outputTokens: 40,
      cacheHitRatePercent: 95,
      sessionCacheHitRatePercent: 90,
    },
    latest: "95%",
    average: "90%",
  },
];

for (const scenario of cases) {
  it(
    `CH usage preserves authoritative cache rates (${scenario.name})`,
    { timeout: 30_000 },
    async (t) => {
      const host = new FakeChHost();
      host.add("cache-thread", "/computer/cache-project", "Cache example");
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (method === "codexhost/thread/usage/inspect")
          return { threadId: params.threadId, usage: scenario.usage } as T;
        return request<T>(method, params);
      };
      const debuggerServer = await startFakeChDebugger(host);
      t.after(() => debuggerServer.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--session-source", "codexhost", "--ch-cdp", debuggerServer.endpoint],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const folder = page.getByRole("treeitem").filter({ hasText: /^cache-project$/u });
      await folder.waitFor();
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator('[data-row-key^="session:"]').filter({ hasText: "Cache example" }).click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      const hostUsage = page.locator('[data-composer-stat="codexhost-usage"] button');
      await hostUsage.waitFor();
      assert.match(
        await hostUsage.innerText(),
        new RegExp(`CH ${scenario.latest.replace(".", "\\.")}`),
      );
      const generic = page.locator('[data-composer-stat="usage"]');
      assert.equal(await generic.count(), 0);
      const screenshots = process.env.CODEXHOST_TEST_SCREENSHOTS;
      if (screenshots) {
        mkdirSync(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, `${scenario.name}-summary.png`) });
      }
      await hostUsage.click();
      const dialog = page.getByRole("dialog", { name: "Usage details", exact: true });
      await dialog.waitFor();
      assert.equal(
        await dialog
          .locator("dt")
          .filter({ hasText: "Average cache hit" })
          .locator("+ dd")
          .innerText(),
        scenario.average,
      );
      assert.equal(
        await dialog
          .locator("dt")
          .filter({ hasText: "Latest cache hit (CH)" })
          .locator("+ dd")
          .innerText(),
        scenario.latest,
      );
      if (screenshots)
        await page.screenshot({ path: join(screenshots, `${scenario.name}-details.png`) });
      assert.deepEqual(errors, []);
    },
  );
}

it(
  "updates usage timing in a newly bound conversation without reopening it",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-browser-live-usage-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.add("existing", "/computer/timing", "Existing timing workspace");
    let usage: ThreadUsageSnapshot | null = null;
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
      method === "codexhost/thread/usage/inspect"
        ? ({
            threadId: params.threadId,
            usage,
            accountCredits: { usedPercent: 5, periodType: "weekly" },
          } as T)
        : request<T>(method, params);
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--ch-cdp",
        debuggerServer.endpoint,
        "--ch-control-directory",
        directory,
        "--harness",
        "fake",
      ],
    );
    const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    page.setDefaultTimeout(6000);
    const follows = new Set<string>();
    const timingFrames: string[] = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "open" && frame.endpoint === "session/follow")
          follows.add(frame.streamId);
      });
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (
          follows.has(frame.streamId) &&
          frame.value?.key === "codexhostUsage" &&
          frame.value?.value?.usage?.outputTokensPerSecond !== undefined
        )
          timingFrames.push(frame.value.sessionId);
      });
    });
    await page.goto(url);
    await page.locator('[data-composer-input][contenteditable="true"]').fill("measure this turn");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("CH response: measure this turn", { exact: true }).waitFor();
    const thread = [...host.threads.values()].find((row) => row.id.startsWith("canonical-"));
    assert.ok(thread);
    await page.locator('[data-composer-stat="codexhost-quota"] button').waitFor();
    usage = { timeToFirstOutputMs: 950 };
    host.changed(thread.id, "codexhost/thread/usage/updated");

    const meter = page.locator('[data-composer-stat="codexhost-usage"] button');
    await meter.waitFor({ timeout: 6000 });
    await meter.click();
    const dialog = page.getByRole("dialog", { name: "Usage details", exact: true });
    await dialog.getByText("950 ms", { exact: true }).waitFor();

    usage = { ...usage, outputTokensPerSecond: 73 };
    host.changed(thread.id, "codexhost/thread/usage/updated");
    await dialog.getByText("73 tok/s", { exact: true }).waitFor();
    assert.ok(timingFrames.includes(thread.id));
  },
);
