import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (executablePath) test.use({ launchOptions: { executablePath } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";
      import {
        COMPOSER_DELEGATE_METHOD, HANDOFF_PREVIEW_METHOD, HANDOFF_SEND_METHOD,
      } from "@codexhost/shared-contracts";

      const inspection = {
        status: "ready",
        catalog: {
          models: [
            { ref: { id: "alpha" }, label: "Alpha", supportedThinkingOptionIds: ["low"] },
            { ref: { id: "beta" }, label: "Beta", supportedThinkingOptionIds: ["high"] },
          ],
          defaultModel: { id: "alpha" },
          thinkingOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
        },
        capabilities: {
          configuration: { selectModel: true, selectThinkingOption: true, selectPermissionMode: false },
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        },
      };

      const editor = document.querySelector("[role=textbox]");
      const view = {
        dom: editor,
        get state() {
          const content = editor.textContent;
          return {
            doc: { content: { size: content.length }, textBetween: (from, to) => content.slice(from, to) },
            schema: { nodes: {} },
            tr: { delete: (from, to) => [from, to] },
          };
        },
        posAtDOM: (_node, offset) => offset,
        dispatch([from, to]) {
          const text = editor.textContent;
          editor.textContent = text.slice(0, from) + text.slice(to);
          editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
        },
      };
      // The controller returns one document object per editor revision.
      const state = Object.getOwnPropertyDescriptor(view, "state").get;
      let previousState;
      let previousText;
      Object.defineProperty(view, "state", { get() {
        if (!previousState || previousText !== editor.textContent) {
          previousText = editor.textContent;
          previousState = state.call(view);
        }
        return previousState;
      }});
      const modelState = {
        atom: {},
        get: () => ({ isManuallyChanged: false, modelSettings: null, serviceTier: null }),
        set: () => undefined,
      };
      Object.defineProperty(editor, "__reactFiber\$fixture", { enumerable: true, value: {
        memoizedProps: {
          isOrbit: false,
          composerController: { view, insertMentionNodeInRange() {} },
        },
        updateQueue: { memoCache: { data: [
          [undefined, modelState, modelState],
          [{}, {}, "client-new-thread:composer-routing", modelState, undefined, modelState, modelState],
        ] } },
        return: null,
      }});

      let owner = "codex";
      globalThis.requests = [];
      let failSend = true;
      const client = createRendererModelClient([{
        async sendRequest(method, params) {
          globalThis.requests.push({ method, params });
          switch (method) {
            case "codexhost/harness/plugins/list":
              return { plugins: [{ id: "pi", name: "Pi", version: "1" }] };
            case "codexhost/harness/inspect": return inspection;
            case "codexhost/thread/inspect":
              return owner === "codex" ? { owner, locked: true } : {
                owner: "external", locked: true, harnessId: "pi",
                transportModelId: "codexhost/pi-native",
                effectiveModel: { id: "alpha" }, effectiveThinkingOptionId: "low",
                history: inspection.capabilities.history,
              };
            case HANDOFF_PREVIEW_METHOD:
              return { summary: "Codex found a missing check in this workspace.", revision: "a".repeat(64) };
            case HANDOFF_SEND_METHOD:
              if (failSend) { failSend = false; throw new Error("Target refused"); }
              owner = "pi";
              return { turnId: "handoff-turn" };
            case COMPOSER_DELEGATE_METHOD:
              if (failSend && params.threadId) { failSend = false; throw new Error("Model is unavailable"); }
              return { threadId: "child-thread" };
            case "codexhost/thread/commands/inspect": return { commands: [] };
            default: throw new Error("Unused fixture method: " + method);
          }
        },
      }]);
      const binding = installRendererBindingProbe({ enabledAgents: ["codex", "pi"] });
      binding.setAdapter({ state: "ready", reason: "ready", modelUpdates: 0, hook: "model-state" },
        undefined, () => true, client);
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

const outputFile = outputFiles[0];
if (!outputFile) throw new Error("Renderer Composer routing bundle was not generated");
const bundle = outputFile.text;

async function loadComposer(page: Page, draft = false) {
  await page.route("https://codexhost.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body><form data-codex-composer-root>
        <div data-above-composer-portal ${draft ? "" : 'data-above-composer-conversation-id="parent-thread"'}></div>
        <div contenteditable="true" role="textbox" data-codex-composer>${draft ? "" : "Write the check"}</div>
        <div><button type="submit" aria-label="Send">Send</button></div>
      </form></body>`,
    }),
  );
  await page.goto("https://codexhost.test/");
  if (draft) {
    await page.evaluate(() =>
      Reflect.set(window, "__codexhostDraftWorkspacesV1", { local: "/work" }),
    );
  }
  await page.addScriptTag({ content: bundle });
}

test("previews, cancels, and retries a handoff without losing the native draft", async ({
  page,
}) => {
  await loadComposer(page);
  const editor = page.getByRole("textbox");
  const openPicker = () =>
    page.getByRole("button", { name: "Switch Agent, current Codex" }).click();
  await openPicker();
  await expect(page.getByRole("group", { name: "Switch conversation Agent" })).toBeVisible();
  await page
    .getByRole("group", { name: "Switch conversation Agent" })
    .getByRole("button", { name: "Pi", exact: true })
    .click();
  await page.getByText("Review handoff summary").click();
  await expect(page.getByText("Codex found a missing check in this workspace.")).toBeVisible();
  await page.getByRole("button", { name: "Use for next turn" }).click();
  await expect(page.getByText("Next ordinary message → Pi")).toBeVisible();
  await page.getByRole("button", { name: "Cancel handoff" }).click();
  await expect(page.getByText("Next ordinary message → Pi")).toHaveCount(0);
  await openPicker();
  await page
    .getByRole("group", { name: "Switch conversation Agent" })
    .getByRole("button", { name: "Pi", exact: true })
    .click();
  await page.getByRole("button", { name: "Use for next turn" }).click();

  await editor.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Target refused" })).toBeVisible();
  await expect(editor).toHaveText("Write the check");
  await page.getByRole("button", { name: "Send to Pi" }).click();
  await expect(editor).toHaveText("");
  await expect(page.getByRole("button", { name: "Switch Agent, current Pi" })).toBeVisible();
  const sends = await page.evaluate(() =>
    Reflect.get(globalThis, "requests").filter(
      ({ method }: { method: string }) => method === "codexhost/thread/handoff/send",
    ),
  );
  expect(sends).toHaveLength(2);
  expect(sends[0]).toEqual(sends[1]);
  expect(sends[0].params).toMatchObject({
    threadId: "parent-thread",
    harnessId: "pi",
    text: "Write the check",
  });
});

test("# applies to the draft, requires a valid pair and sends the configured child", async ({
  page,
}) => {
  await loadComposer(page);
  const editor = page.getByRole("textbox");
  await editor.press("End");
  await editor.press("Space");
  await editor.press("#");
  const panel = page.getByRole("group", { name: "Configure delegation" });
  await expect(panel).toBeVisible();
  await expect(page.locator("[data-codexhost-delegation-trigger]")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Apply delegation" })).toBeDisabled();
  await panel.getByRole("button", { name: "Pi", exact: true }).click();
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  const thinking = page.getByRole("combobox", { name: "Thinking", exact: true });
  const apply = page.getByRole("button", { name: "Apply delegation" });
  await thinking.selectOption("low");
  await model.selectOption("beta");
  await expect(apply).toBeDisabled();
  await thinking.selectOption("high");
  await apply.click();
  await expect(page.getByRole("button", { name: "# Pi · Beta · High" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      Reflect.get(globalThis, "requests").some(
        ({ method }: { method: string }) => method === "codexhost/thread/delegate/start",
      ),
    ),
  ).toBe(false);

  await editor.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Model is unavailable" })).toBeVisible();
  await expect(editor).toContainText("Write the check");
  await page.getByRole("button", { name: "# Pi · Beta · High" }).click();
  await expect(model).toHaveValue("beta");
  await expect(thinking).toHaveValue("high");
  await apply.click();
  await page.getByRole("button", { name: "Send to Pi" }).click();
  await expect(page.getByRole("button", { name: "Open delegated Thread" })).toBeVisible();
  await expect(editor).toHaveText("");
  const sends = await page.evaluate(() =>
    Reflect.get(globalThis, "requests").filter(
      ({ method }: { method: string }) => method === "codexhost/thread/delegate/start",
    ),
  );
  expect(sends).toHaveLength(2);
  expect(sends[1].params).toMatchObject({
    threadId: "parent-thread",
    harnessId: "pi",
    model: { id: "beta" },
    thinkingOptionId: "high",
  });
});

test("a single # in a blank new chat starts its first turn with the selected configuration", async ({
  page,
}) => {
  await loadComposer(page, true);
  const editor = page.getByRole("textbox");
  await editor.press("#");
  const panel = page.getByRole("group", { name: "Configure delegation" });
  await expect(panel).toBeVisible();
  await expect(editor).toBeEmpty();
  await panel.getByRole("button", { name: "Pi", exact: true }).click();
  await panel.getByRole("combobox", { name: "Model", exact: true }).selectOption("beta");
  await panel.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
  await panel.getByRole("button", { name: "Apply delegation" }).click();
  await editor.fill("Write the first reply");
  await expect(editor).toHaveText("Write the first reply");
  await editor.press("Enter");
  await expect(page.getByRole("button", { name: "Open delegated Thread" })).toBeVisible();
  const calls = await page.evaluate(() => Reflect.get(globalThis, "requests"));
  expect(calls).toContainEqual({
    method: "codexhost/harness/inspect",
    params: { harnessId: "pi", cwd: "/work", refresh: true },
  });
  const starts = calls.filter(
    ({ method }: { method: string }) => method === "codexhost/thread/delegate/start",
  );
  expect(starts).toHaveLength(1);
  expect(starts[0].params).toEqual({
    cwd: "/work",
    harnessId: "pi",
    requestId: expect.any(String),
    text: "Write the first reply",
    model: { id: "beta" },
    thinkingOptionId: "high",
  });
});
