import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (executablePath) test.use({ launchOptions: { executablePath } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountComposerRouting } from "./packages/renderer-extension/src/renderer-composer-routing.ts";
      import { RendererCodexAccountState } from "./packages/renderer-extension/src/renderer-codex-account-state.ts";
      import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";

      const targets = [
        { agent: "codex", label: "Codex" },
        { agent: "pi", label: "Pi" },
        { agent: "claude-code", label: "Claude Code" },
      ];
      const requests = [];
      const snapshots = new Map();
      const notifications = new Set();
      let currentEmail;
      function ready(models) {
        return {
          status: "ready",
          catalog: {
            models: models.map(([id, efforts]) => ({
              ref: { id }, label: id, supportedThinkingOptionIds: efforts,
            })),
            defaultModel: { id: models[0][0] },
            thinkingOptions: [...new Set(models.flatMap(([, efforts]) => efforts))]
              .map((id) => ({ id, label: id })),
          },
          capabilities: {
            configuration: { selectModel: true, selectThinkingOption: true, selectPermissionMode: false },
            history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
          },
        };
      }
      function clientFor(connection) {
        return createRendererModelClient([{
          async sendRequest(method, params) {
            if (method === "codexhost/harness/credential-imports") return { sources: [], targets: [] };
            if (method === "codexhost/thread/delegate/catalog" && params.action === "snapshot")
              return snapshots.get(JSON.stringify([connection, params.hostId, currentEmail, params.cwd])) ?? null;
            if (method !== "codexhost/harness/inspect" && method !== "codexhost/thread/delegate/catalog")
              throw new Error(method);
            return new Promise((resolve, reject) => requests.push({ connection, params, resolve, reject }));
          },
          addNotificationCallback(method, listener) {
            notifications.add({ method, listener });
            return () => {};
          },
        }]);
      }
      const clients = { primary: clientFor("primary"), replacement: clientFor("replacement") };
      const accounts = new RendererCodexAccountState(clients.primary, () => routing.sync());
      let context = {
        client: clients.primary, hostId: "local", draftId: "draft", cwd: "/work",
      };
      const routing = mountComposerRouting(document.querySelector("[role=textbox]"), {
        context: () => context,
        codexAccounts: () => accounts,
        chinese: () => false,
        currentAgent: () => targets[0],
        targets: () => targets,
        onHandoff() {},
        async openChild() {},
      });
      globalThis.catalogFixture = {
        open(agent) { routing.configureDelegation(targets.find((target) => target.agent === agent)); },
        calls() { return requests.map(({ connection, params }) => ({ connection, params })); },
        complete(index, models) { requests[index].resolve(ready(models)); },
        seed(email, models) { snapshots.set(JSON.stringify(["primary", "local", email, "/work"]), ready(models)); },
        reject(index) { requests[index].reject(new Error("Agent temporarily unavailable")); },
        context(location, hostId = "local", connection = "primary") {
          context = { client: clients[connection], hostId, ...location };
          routing.sync();
        },
        account(email, revision = 1) {
          currentEmail = email;
          const params = {
            version: 2, phase: "ready", revision, instanceId: "host-instance",
            currentAccountId: email ? "current" : null,
            accounts: email ? [{ accountId: "current", email, label: email }] : [],
          };
          for (const { method, listener } of notifications) listener({ method, params });
        },
        changeCredentials() {
          return clients.primary.credentialImports({ action: "remove", name: "imported", confirmed: true }, "pi");
        },
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});

const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Renderer delegation catalog bundle was not generated");

type Models = [id: string, efforts: string[]][];
type Location = { draftId: string; cwd: string } | { threadId: string };
interface CatalogFixture {
  open(agent?: string): void;
  calls(): { connection: string; params: object }[];
  complete(index: number, models: Models): void;
  reject(index: number): void;
  context(location: Location, hostId?: string, connection?: string): void;
  seed(email: string, models: Models): void;
  account(email?: string, revision?: number): void;
  changeCredentials(): Promise<unknown>;
}

declare global {
  var catalogFixture: CatalogFixture;
}

const model = (page: Page) => page.getByRole("combobox", { name: "Model", exact: true });
const thinking = (page: Page) => page.getByRole("combobox", { name: "Thinking", exact: true });
const apply = (page: Page) => page.getByRole("button", { name: "Apply delegation" });
const cancel = (page: Page) => page.getByRole("button", { name: "Cancel", exact: true });

async function complete(page: Page, index: number, models: Models) {
  await page.evaluate(({ index, models }) => catalogFixture.complete(index, models), {
    index,
    models,
  });
}

test.beforeEach(async ({ page }) => {
  await page.setContent('<div contenteditable="true" role="textbox"></div>');
  await page.addScriptTag({ content: bundle });
});

test("renders a warm catalog before refresh and keeps the latest explicit selections", async ({
  page,
}) => {
  await page.evaluate(() => {
    catalogFixture.seed("current@example.com", [
      ["alpha", ["low"]],
      ["beta", ["high"]],
    ]);
    catalogFixture.account("current@example.com");
  });
  expect(await page.evaluate(() => catalogFixture.calls())).toHaveLength(0);
  const firstOpenShowsSnapshot = await page.evaluate(() => {
    catalogFixture.open("codex");
    return Boolean(document.querySelector('option[value="alpha"]'));
  });
  expect(firstOpenShowsSnapshot).toBe(true);
  await model(page).selectOption("alpha");
  await thinking(page).selectOption("low");
  await apply(page).click();

  await page.getByRole("button", { name: "# Codex · alpha · low" }).click();
  await expect(model(page)).toHaveValue("alpha");
  await expect(thinking(page)).toHaveValue("low");
  await model(page).selectOption("beta");
  await thinking(page).selectOption("high");
  await thinking(page).focus();
  expect(await page.evaluate(() => catalogFixture.calls())).toHaveLength(1);
  await complete(page, 0, [
    ["beta", ["high"]],
    ["gamma", ["low"]],
  ]);
  await expect(model(page).locator("option", { hasText: "gamma" })).toHaveCount(1);
  await expect(model(page)).toHaveValue("beta");
  await expect(thinking(page)).toHaveValue("high");
  await expect(thinking(page)).toBeFocused();
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await page.getByRole("button", { name: "# Codex · beta · high" }).click();
  await expect(model(page).locator("option", { hasText: "gamma" })).toHaveCount(1);
  expect(await page.evaluate(() => catalogFixture.calls())).toHaveLength(1);
});

test("requires a replacement when refresh removes the selected thinking option or model", async ({
  page,
}) => {
  await page.evaluate(() => {
    catalogFixture.seed("current@example.com", [["alpha", ["low", "high"]]]);
    catalogFixture.account("current@example.com");
    catalogFixture.open("codex");
  });
  await model(page).selectOption("alpha");
  await thinking(page).selectOption("high");
  await complete(page, 0, [["alpha", ["low"]]]);
  const review = page
    .getByRole("status")
    .filter({ hasText: "Review the model and thinking selections" });
  await expect(review).toBeVisible();
  await expect(model(page)).toHaveValue("alpha");
  await expect(apply(page)).toBeDisabled();
  await thinking(page).selectOption("low");
  await apply(page).click();

  await page.evaluate(() => {
    catalogFixture.seed("current@example.com", [["alpha", ["low"]]]);
    catalogFixture.account("current@example.com", 2);
  });
  await page.getByRole("button", { name: "# Codex · alpha · low" }).click();
  await expect(model(page)).toHaveValue("alpha");
  await complete(page, 1, [["beta", ["low"]]]);
  await expect(review).toBeVisible();
  await expect(model(page).locator("option:checked")).toHaveText("Choose again");
  await expect(apply(page)).toBeDisabled();
  await model(page).selectOption("beta");
  await expect(thinking(page)).toHaveValue("low");
  await expect(apply(page)).toBeEnabled();
});

test("keeps Agent requests separate and shares an in-flight refresh when reopened", async ({
  page,
}) => {
  await page.evaluate(() => catalogFixture.open("pi"));
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await complete(page, 1, [["claude", ["low"]]]);
  await expect(model(page).locator("option", { hasText: "claude" })).toHaveCount(1);
  await cancel(page).click();
  await page.evaluate(() => catalogFixture.open("pi"));
  await expect(model(page)).toBeHidden();
  expect(await page.evaluate(() => catalogFixture.calls())).toHaveLength(2);
  await complete(page, 0, [["pi-model", ["low"]]]);
  await expect(model(page).locator("option", { hasText: "pi-model" })).toHaveCount(1);
  await cancel(page).click();
  await page.evaluate(() => catalogFixture.open("pi"));
  await expect(model(page).locator("option", { hasText: "pi-model" })).toHaveCount(1);
  expect(await page.evaluate(() => catalogFixture.calls())).toHaveLength(2);
});

test("isolates workspace, Host, replacement connection and existing Thread", async ({ page }) => {
  await page.evaluate(() => catalogFixture.open("pi"));
  await complete(page, 0, [["work-model", ["low"]]]);
  await expect(model(page)).toBeVisible();
  await cancel(page).click();
  const open = (location: Location, hostId?: string, connection?: string) =>
    page.evaluate(
      ({ location, hostId, connection }) => {
        catalogFixture.context(location, hostId, connection);
        catalogFixture.open("pi");
      },
      { location, hostId, connection },
    );

  await open({ draftId: "draft", cwd: "/elsewhere" });
  await expect(model(page)).toBeHidden();
  await open({ draftId: "draft", cwd: "/work" }, "remote");
  await expect(model(page)).toBeHidden();
  await complete(page, 1, [["late-workspace", ["low"]]]);
  await expect(model(page)).toBeHidden();
  await complete(page, 2, [["remote-model", ["low"]]]);
  await expect(model(page).locator("option", { hasText: "remote-model" })).toHaveCount(1);
  await open({ draftId: "draft", cwd: "/work" }, "local", "replacement");
  await expect(model(page)).toBeHidden();
  await open({ threadId: "parent-thread" });
  await expect(model(page)).toBeHidden();
  expect((await page.evaluate(() => catalogFixture.calls())).at(-1)).toEqual({
    connection: "primary",
    params: { harnessId: "pi", threadId: "parent-thread", refresh: true },
  });
});

test("invalidates an open Codex catalog when the effective account changes", async ({ page }) => {
  await page.evaluate(() => {
    catalogFixture.seed("first@example.com", [["first-account-model", ["low"]]]);
    catalogFixture.account("first@example.com");
    catalogFixture.open("codex");
  });
  await expect(model(page)).toBeVisible();
  await cancel(page).click();
  await page.evaluate(() => catalogFixture.open("codex"));
  await expect(model(page).locator("option", { hasText: "first-account-model" })).toHaveCount(1);

  await page.evaluate(() => catalogFixture.account("second@example.com", 2));
  await expect(model(page)).toBeHidden();
  await complete(page, 0, [["stale-first-account", ["low"]]]);
  await expect.poll(() => page.evaluate(() => catalogFixture.calls())).toHaveLength(2);
  await expect(model(page)).toBeHidden();
  await complete(page, 1, [["second-account-model", ["low"]]]);
  await expect(model(page).locator("option", { hasText: "second-account-model" })).toHaveCount(1);
  await page.evaluate(() => catalogFixture.account(undefined, 3));
  await expect(model(page)).toBeHidden();
});

test("drops warm external catalogs after credential operations or foreground changes", async ({
  page,
}) => {
  await page.evaluate(() => catalogFixture.open("pi"));
  await complete(page, 0, [["old-credentials", ["low"]]]);
  await expect(model(page)).toBeVisible();
  await cancel(page).click();
  await page.evaluate(() => catalogFixture.open("pi"));
  await expect(model(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(model(page)).toBeHidden();
  await page.evaluate(() => catalogFixture.changeCredentials());
  await expect(model(page)).toBeHidden();
  expect(await page.evaluate(() => catalogFixture.calls())).toHaveLength(2);
  await complete(page, 1, [["late-old-credentials", ["low"]]]);
  await expect.poll(() => page.evaluate(() => catalogFixture.calls())).toHaveLength(3);
  await expect(model(page)).toBeHidden();
  await complete(page, 2, [["new-credentials", ["low"]]]);
  await expect(model(page).locator("option", { hasText: "new-credentials" })).toHaveCount(1);
  await cancel(page).click();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    catalogFixture.open("pi");
  });
  await expect(model(page)).toBeHidden();
});

test("retains the last successful snapshot after failure and retries", async ({ page }) => {
  await page.evaluate(() => {
    catalogFixture.seed("current@example.com", [["old", ["low"]]]);
    catalogFixture.account("current@example.com");
    catalogFixture.open("codex");
  });
  await expect(apply(page)).toBeEnabled();
  await model(page).selectOption("old");
  await page.evaluate(() => catalogFixture.reject(0));
  await expect(page.getByRole("status")).toContainText("Agent temporarily unavailable");
  await expect(apply(page)).toBeEnabled();
  await expect(model(page)).toHaveValue("old");
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(model(page)).toHaveValue("old");
  await complete(page, 1, [["recovered", ["low"]]]);
  await expect(model(page).locator("option", { hasText: "recovered" })).toHaveCount(1);
  await expect(model(page).locator("option:checked")).toHaveText("Choose again");
});
