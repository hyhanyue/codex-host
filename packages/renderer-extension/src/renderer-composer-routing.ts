import {
  harnessIdSchema,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type HandoffPreviewResult,
  type HostThreadId,
} from "@codexhost/shared-contracts";

import { createRendererAgentIcon } from "./renderer-agent-icon.js";
import routingPanelCss from "./renderer-composer-routing.css";
import type { RendererCodexAccountState } from "./renderer-codex-account-state.js";
import {
  delegationCatalogCache,
  delegationCatalogScope,
  DelegationCatalogScopeChanged,
  subscribeDelegationCatalogInvalidation,
} from "./renderer-delegation-catalog.js";
import type { RendererDelegationTarget } from "./renderer-delegation-mention.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import { readNativeTextDraft } from "./renderer-native-composer-controller.js";

type RoutingContext = {
  client: RendererModelClient;
  hostId: string;
} & ({ threadId: HostThreadId } | { draftId: string; cwd?: string });

function routingScope(context: RoutingContext | null): string | undefined {
  if (!context) return undefined;
  return JSON.stringify(
    "threadId" in context
      ? [context.hostId, "thread", context.threadId]
      : [context.hostId, "draft", context.draftId, context.cwd],
  );
}

function catalogLocation(context: RoutingContext) {
  if ("threadId" in context) return { threadId: context.threadId };
  return context.cwd ? { cwd: context.cwd } : null;
}

interface DelegationDraft {
  target: RendererDelegationTarget;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  label: string;
}

interface HandoffDraft {
  target: RendererDelegationTarget;
  preview: HandoffPreviewResult;
}

export function mountComposerRouting(
  editor: HTMLElement,
  options: {
    context(): RoutingContext | null;
    codexAccounts?(hostId: string): RendererCodexAccountState | null;
    chinese(): boolean;
    currentAgent(): RendererDelegationTarget;
    targets(): RendererDelegationTarget[];
    onHandoff(): void;
    openChild(threadId: HostThreadId, hostId: string): Promise<void>;
  },
) {
  const document = editor.ownerDocument;
  if (!document.querySelector("style[data-codexhost-routing-style]")) {
    const style = document.createElement("style");
    style.dataset.codexhostRoutingStyle = "";
    style.textContent = routingPanelCss;
    (document.head ?? document.documentElement).append(style);
  }
  const root = document.createElement("div");
  root.dataset.codexhostComposerRouting = "";
  root.className = "text-sm";
  const chips = document.createElement("div");
  chips.className = "flex flex-wrap items-center gap-1";
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  const panel = document.createElement("div");
  panel.className =
    "flex min-w-0 flex-col gap-3 rounded-xl border border-default bg-surface-elevated-secondary p-3 shadow-sm";
  panel.style.marginBottom = "8px";
  panel.setAttribute("role", "group");
  root.append(chips, notice);
  const anchor = editor.closest("[data-composer-body]");
  if (anchor) {
    anchor.before(panel);
    anchor.prepend(root);
  } else {
    editor.before(panel, root);
  }

  let delegation: DelegationDraft | null = null;
  let handoff: HandoffDraft | null = null;
  let generation = 0;
  let panelKind: "handoff" | "delegation" | null = null;
  let syncDelegationCatalog: (() => void) | undefined;
  const unsubscribeCatalog = subscribeDelegationCatalogInvalidation(document, () =>
    syncDelegationCatalog?.(),
  );
  const preloadCodexCatalog = (context: RoutingContext | null) => {
    if (!context) return;
    const location = catalogLocation(context);
    if (!location) return;
    const scopeFor = () =>
      delegationCatalogScope(
        document,
        context.client,
        context.hostId,
        harnessIdSchema.parse("codex"),
        location,
        undefined,
        options.codexAccounts?.(context.hostId),
      );
    const catalogScope = scopeFor();
    if (!catalogScope.persistent) return;
    void delegationCatalogCache(context.client).preload(
      catalogScope,
      () => options.context()?.client === context.client && scopeFor().key === catalogScope.key,
    );
  };
  let pending = false;
  let disposed = false;
  let scope: string | undefined;
  let attempt: { key: string; requestId: string } | undefined;
  let child: { threadId: HostThreadId; hostId: string } | null = null;
  const t = (en: string, zh: string) => (options.chinese() ? zh : en);

  const button = (label: string, action: () => void, disabled = false) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.className = "cursor-interaction rounded-md border border-default px-2 py-1 text-start";
    element.disabled = disabled;
    element.addEventListener("click", action);
    return element;
  };
  const status = (message = "") => {
    if (notice.textContent !== message) notice.textContent = message;
    notice.hidden = !message;
  };
  const fail = (error: unknown, guidance = "") =>
    status(
      [error instanceof Error ? error.message : String(error), guidance].filter(Boolean).join(" "),
    );

  const draw = () => {
    chips.replaceChildren();
    chips.style.display = delegation || handoff || child ? "" : "none";
    if (handoff) {
      const { target } = handoff;
      chips.append(
        button(
          t(`Next ordinary message → ${target.label}`, `下一条普通消息 → ${target.label}`),
          () => openHandoff(target),
          pending,
        ),
        button(
          t("Cancel handoff", "取消交接"),
          () => {
            handoff = null;
            status();
            draw();
          },
          pending,
        ),
      );
    }
    if (delegation) {
      const { target, label } = delegation;
      chips.append(
        button(`# ${label}`, () => configureDelegation(target), pending),
        button(
          t("Remove delegation", "移除委派"),
          () => {
            delegation = null;
            status();
            draw();
          },
          pending,
        ),
      );
    }
    const destination = delegation?.target ?? handoff?.target;
    if (destination) {
      chips.append(
        button(
          t(`Send to ${destination.label}`, `发送给 ${destination.label}`),
          () => {
            submit();
          },
          pending || panelKind !== null,
        ),
      );
    }
    if (child) {
      const { threadId, hostId } = child;
      chips.append(
        button(t("Open delegated Thread", "打开委派会话"), () => {
          void options.openChild(threadId, hostId).catch((error) => fail(error));
        }),
      );
    }
    panel.style.display = panelKind ? "" : "none";
  };

  const closePanel = () => {
    generation += 1;
    syncDelegationCatalog = undefined;
    panelKind = null;
    root.append(notice);
    panel.replaceChildren();
    draw();
    editor.focus();
  };

  const startPanel = (
    kind: "handoff" | "delegation",
    title: string,
    subtitle: string,
    action: string,
    selected: RendererDelegationTarget | undefined,
    choose: (target: RendererDelegationTarget) => void,
    apply: () => void,
  ) => {
    const current = options.currentAgent();
    const header = document.createElement("div");
    header.className = "flex items-start justify-between gap-2";
    const heading = document.createElement("strong");
    heading.className = "text-base";
    heading.textContent = title;
    const description = document.createElement("div");
    description.className = "text-codex-description";
    description.textContent = subtitle;
    const copy = document.createElement("div");
    copy.append(heading, description);
    const badge = document.createElement("span");
    badge.className =
      "shrink-0 rounded-md border border-default px-1.5 text-xs text-codex-description";
    if (kind === "delegation") badge.textContent = "#";
    badge.hidden = kind === "handoff";
    header.append(copy, badge);

    const agents = document.createElement("div");
    agents.className = "grid gap-2";
    agents.style.gridTemplateColumns = "repeat(auto-fit, minmax(min(135px, 100%), 1fr))";
    agents.setAttribute("role", "group");
    agents.setAttribute(
      "aria-label",
      kind === "handoff" ? t("Switch to", "切换到") : t("Delegate to", "委派给"),
    );
    const available = options.targets();
    const targets =
      kind === "handoff" && !available.some(({ agent }) => agent === current.agent)
        ? [current, ...available]
        : available;
    for (const target of targets) {
      const active = target.agent === selected?.agent;
      const disabled =
        kind === "handoff" && (target.agent === "codex" || target.agent === current.agent);
      const card = button("", () => choose(target), disabled);
      card.className =
        "flex min-w-0 items-center gap-2 rounded-lg border border-default px-2 py-1.5 text-start " +
        "enabled:hover:bg-primary-ghost-hover disabled:opacity-50";
      card.setAttribute("aria-pressed", String(active));
      card.dataset.agent = target.agent;
      const icon = createRendererAgentIcon(target.agent, 18, document, target.plugin);
      icon.classList.add("shrink-0");
      const name = document.createElement("span");
      name.className = "truncate";
      name.textContent = target.label;
      card.append(icon, name);
      if (active) {
        card.style.borderColor = "var(--color-text-accent, #9b80f5)";
        card.style.background = "color-mix(in srgb, #9b80f5 20%, transparent)";
      }
      agents.append(card);
    }

    const body = document.createElement("div");
    body.className = "text-codex-description";
    body.hidden = true;
    const footer = document.createElement("div");
    footer.className =
      "flex flex-wrap items-center justify-between gap-2 border-t border-default pt-2";
    const route = document.createElement("div");
    route.className = "min-w-0 text-codex-description";
    const actions = document.createElement("div");
    actions.className = "ml-auto flex shrink-0 gap-2";
    const cancel = button(t("Cancel", "取消"), () => {
      status();
      closePanel();
    });
    cancel.className = "cursor-interaction rounded-md px-2 py-1.5 hover:bg-primary-ghost-hover";
    const confirm = button(action, apply, true);
    confirm.className =
      "cursor-interaction rounded-md bg-token-text-primary px-3 py-1.5 font-medium " +
      "text-token-bg-primary disabled:opacity-50";
    confirm.style.background = "CanvasText";
    confirm.style.color = "Canvas";
    actions.append(cancel, confirm);
    if (kind === "handoff") {
      route.textContent = selected ? `${current.label} → ${selected.label}` : current.label;
    }
    route.append(notice);
    footer.append(route, actions);
    panel.setAttribute("aria-label", title);
    panel.dataset.codexhostRoutingPanel = kind;
    panel.replaceChildren(header, agents, body, footer);
    panelKind = kind;
    status(selected ? t("Loading…", "加载中…") : t("Choose an Agent", "选择目标 Agent"));
    draw();
    scope = routingScope(options.context());
    (
      agents.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ??
      agents.querySelector<HTMLButtonElement>("button:enabled") ??
      cancel
    ).focus({ preventScroll: true });
    return { token: ++generation, badge, body, confirm };
  };
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  });

  const openHandoff = (target = handoff?.target): boolean => {
    const context = options.context();
    if (
      !context ||
      !("threadId" in context) ||
      !context.client.previewHandoff ||
      !context.client.sendHandoff ||
      pending
    )
      return false;
    let preview: HandoffPreviewResult | undefined;
    const { token, badge, body, confirm } = startPanel(
      "handoff",
      t("Switch conversation Agent", "切换会话 Agent"),
      t(
        "Keep this conversation and hand off when you send the next message.",
        "保留当前会话，发送下一条消息时交接。",
      ),
      t("Use for next turn", "用于下一轮"),
      target,
      openHandoff,
      () => {
        if (!target || !preview) return;
        handoff = { target, preview };
        status();
        closePanel();
      },
    );
    if (!target) return true;
    const harnessId = harnessIdSchema.parse(target.agent);
    void context.client
      .previewHandoff({ threadId: context.threadId, harnessId })
      .then((result) => {
        if (token !== generation) return;
        preview = result;
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.className = "cursor-interaction";
        summary.textContent = t("Review handoff summary", "查看交接摘要");
        const excerpt = document.createElement("pre");
        excerpt.className = "mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words";
        excerpt.textContent = result.summary;
        details.append(summary, excerpt);
        body.replaceChildren(details);
        body.hidden = false;
        badge.textContent = t("● Turn complete", "● 本轮已结束");
        badge.hidden = false;
        confirm.disabled = false;
        status();
      })
      .catch((error) => {
        if (token === generation) fail(error);
      });
    return true;
  };

  const configureDelegation = (target = delegation?.target): boolean => {
    const context = options.context();
    if (!context?.client.delegateFromComposer || pending) return false;
    let applySelection = () => {};
    const existingThread = "threadId" in context;
    let retryCatalog = () => {};
    const { token, body, confirm } = startPanel(
      "delegation",
      t("Configure delegation", "配置委派"),
      existingThread
        ? t(
            "The child conversation uses your selections on its first turn.",
            "子会话从第一轮使用所选配置。",
          )
        : t(
            "The new conversation uses your selections on its first turn.",
            "新会话从第一轮使用所选配置。",
          ),
      t("Apply delegation", "应用到委派"),
      target,
      (next) => {
        if (next.agent === target?.agent) retryCatalog();
        else configureDelegation(next);
      },
      () => applySelection(),
    );
    if (!target) return true;
    const location = catalogLocation(context);
    if (!location) {
      status(t("Select a workspace to continue.", "请先选择工作区。"));
      return true;
    }
    const harnessId = harnessIdSchema.parse(target.agent);
    const prior = delegation?.target.agent === target.agent ? delegation : null;
    let selectedModelId = prior?.model?.id ?? "";
    let selectedThinkingId = prior?.thinkingOptionId ?? "";
    let inspection: Extract<HarnessInspection, { status: "ready" }> | undefined;
    let catalogError: string | undefined;

    const modelLabel = document.createElement("label");
    const thinkingLabel = document.createElement("label");
    const model = document.createElement("select");
    const thinking = document.createElement("select");
    for (const label of [modelLabel, thinkingLabel]) {
      label.className = "flex min-w-0 flex-col gap-1";
    }
    for (const select of [model, thinking]) {
      select.className =
        "w-full rounded-md border border-default bg-surface-elevated-secondary px-2 py-1.5 text-default";
    }
    const modelDefault = t("Harness default", "Agent 默认");
    const thinkingDefault = t("Model default", "模型默认");
    const reselect = "!reselect";
    const reselectLabel = t("Choose again", "请重新选择");
    modelLabel.append(t("Model ", "模型 "), model);
    thinkingLabel.append(t("Thinking ", "思考强度 "), thinking);
    body.className = "grid grid-cols-2 gap-2 text-codex-description";
    body.replaceChildren(modelLabel, thinkingLabel);

    const modelOptions = () =>
      inspection?.capabilities.configuration.selectModel ? inspection.catalog.models : [];
    const chosenModel = () => modelOptions().find(({ ref }) => ref.id === selectedModelId);
    const thinkingOptions = () => {
      if (!inspection?.capabilities.configuration.selectThinkingOption) return [];
      const model = selectedModelId ? chosenModel()?.ref : inspection.catalog.defaultModel;
      return model ? thinkingOptionsForModel(inspection.catalog, model) : [];
    };
    const setOptions = (
      select: HTMLSelectElement,
      defaultLabel: string,
      choices: { label: string; id: string }[],
      selected: string,
    ) => {
      const invalid = Boolean(selected) && !choices.some(({ id }) => id === selected);
      const options = [
        ...(invalid ? [{ label: reselectLabel, id: reselect }] : []),
        { label: defaultLabel, id: "" },
        ...choices,
      ];
      if (
        options.length !== select.options.length ||
        options.some(({ label, id }, index) => {
          const existing = select.options[index];
          return existing?.value !== id || existing.text !== label;
        })
      ) {
        select.replaceChildren(...options.map(({ label, id }) => new Option(label, id)));
      }
      const value = invalid ? reselect : selected;
      if (select.value !== value) select.value = value;
      select.disabled = choices.length === 0 && !invalid;
      return invalid;
    };
    const renderSelections = () => {
      if (!inspection) return;
      const invalidModel = setOptions(
        model,
        modelDefault,
        modelOptions().map(({ ref, label }) => ({ id: ref.id, label })),
        selectedModelId,
      );
      const invalidThinking = setOptions(
        thinking,
        thinkingDefault,
        thinkingOptions(),
        selectedThinkingId,
      );
      const invalid = invalidModel || invalidThinking;
      confirm.disabled = invalid;
      status(
        catalogError ??
          (invalid
            ? t("Review the model and thinking selections.", "请重新选择模型或思考强度。")
            : ""),
      );
      body.hidden = false;
    };
    model.addEventListener("change", () => {
      if (model.value !== reselect) selectedModelId = model.value;
      renderSelections();
    });
    thinking.addEventListener("change", () => {
      if (thinking.value !== reselect) selectedThinkingId = thinking.value;
      renderSelections();
    });

    const panelScope = routingScope(context);
    const scopeFor = (current: RoutingContext) =>
      delegationCatalogScope(
        document,
        current.client,
        current.hostId,
        harnessId,
        location,
        target.plugin?.version,
        harnessId === "codex" ? options.codexAccounts?.(current.hostId) : undefined,
      );
    let loaded: { client: RendererModelClient; key: string } | undefined;
    const syncCatalog = (retry = false) => {
      if (token !== generation) return;
      const current = options.context();
      if (!current || routingScope(current) !== panelScope) return;
      const catalogScope = scopeFor(current);
      const { key, cacheable, changingCredentials, persistent } = catalogScope;
      if (
        !retry &&
        loaded?.client === current.client &&
        loaded.key === key &&
        (!delegationCatalogCache(current.client).read(key) ||
          delegationCatalogCache(current.client).isFresh(key) ||
          delegationCatalogCache(current.client).isRefreshing(key))
      )
        return;
      const request = { client: current.client, key };
      loaded = request;
      const catalogScopeIsCurrent = () => {
        const latest = options.context();
        return (
          latest?.client === request.client &&
          latest.hostId === current.hostId &&
          scopeFor(latest).key === key
        );
      };
      const stillInScope = () =>
        routingScope(options.context()) === panelScope && catalogScopeIsCurrent();
      inspection = undefined;
      catalogError = undefined;
      body.hidden = true;
      confirm.disabled = true;
      if (changingCredentials) {
        status(t("Agent credentials are being updated.", "正在更新 Agent 凭据。"));
        return;
      }
      const cache = delegationCatalogCache(current.client);
      const ready = (result: NonNullable<typeof inspection>) => {
        inspection = result;
        renderSelections();
      };
      const cached = cacheable ? cache.read(key) : undefined;
      if (cached) ready(cached);
      else status(t("Loading…", "加载中…"));
      const preload =
        !cached && persistent
          ? cache.preload(catalogScope, catalogScopeIsCurrent)
          : Promise.resolve(undefined);
      void preload
        .then((snapshot) => {
          if (snapshot && token === generation && loaded === request && stillInScope())
            ready(snapshot);
          return cache.refresh(catalogScope, { harnessId, ...location }, catalogScopeIsCurrent);
        })
        .then((result) => {
          if (token !== generation || loaded !== request) return;
          if (stillInScope()) ready(result);
          else syncCatalog();
        })
        .catch((error: unknown) => {
          if (token !== generation || loaded !== request) return;
          if (!stillInScope()) {
            syncCatalog();
            return;
          }
          const scopeChanged = error instanceof DelegationCatalogScopeChanged;
          if (!scopeChanged && inspection) {
            // A background refresh failure must not interrupt a usable warm menu.
            catalogError = undefined;
            renderSelections();
            return;
          }
          if (scopeChanged) {
            inspection = undefined;
            body.hidden = true;
            confirm.disabled = true;
            void options
              .codexAccounts?.(current.hostId)
              ?.refresh()
              .then(() => syncCatalog());
          }
          const detail = scopeChanged
            ? t("The Agent account context changed.", "Agent 的账号上下文已变化。")
            : error instanceof Error
              ? error.message
              : String(error);
          catalogError = [
            detail,
            t("Select the Agent again to retry.", "请重新选择 Agent 后重试。"),
          ].join(" ");
          if (inspection) renderSelections();
          else status(catalogError);
        });
    };
    retryCatalog = () => syncCatalog(catalogError !== undefined);
    syncDelegationCatalog = syncCatalog;
    applySelection = () => {
      const request = loaded;
      syncCatalog();
      if (
        loaded !== request ||
        confirm.disabled ||
        !inspection ||
        routingScope(options.context()) !== panelScope
      )
        return;
      const selectedModel = chosenModel();
      const selectedThinking = thinkingOptions().find(({ id }) => id === selectedThinkingId);
      delegation = {
        target,
        ...(selectedModel ? { model: selectedModel.ref } : {}),
        ...(selectedThinking ? { thinkingOptionId: selectedThinking.id } : {}),
        label: [
          target.label,
          selectedModel?.label ?? modelDefault,
          selectedThinking?.label ?? thinkingDefault,
        ].join(" · "),
      };
      status();
      closePanel();
    };
    syncCatalog();
    return true;
  };

  const submit = (): boolean => {
    if (!delegation && !handoff && !pending && !panelKind) return false;
    if (pending || panelKind) return true;
    const context = options.context();
    if (!context || scope !== routingScope(context)) {
      status(
        t("This Thread is unavailable. Reopen it and retry.", "当前会话不可用，请重新打开后重试。"),
      );
      return true;
    }
    const draft = readNativeTextDraft(editor);
    if (!draft) {
      status(t("Use a text-only draft for this send.", "此操作仅支持纯文本草稿。"));
      return true;
    }
    if (!draft.text.trim()) return true;

    const configuration = delegation;
    const selectedHandoff = handoff;
    const target = configuration?.target ?? selectedHandoff?.target;
    if (!target) return true;
    const harnessId = harnessIdSchema.parse(target.agent);
    const key = JSON.stringify([
      scope,
      configuration?.model?.id,
      configuration?.thinkingOptionId,
      configuration ? null : selectedHandoff?.preview.revision,
      harnessId,
      draft.text,
    ]);
    if (attempt?.key !== key) attempt = { key, requestId: crypto.randomUUID() };
    const common = {
      harnessId,
      requestId: attempt.requestId,
      text: draft.text,
    };
    const submittingScope = scope;
    pending = true;
    draw();
    status(t(`Sending to ${target.label}…`, `正在发送给 ${target.label}…`));
    void (async () => {
      try {
        if (configuration && context.client.delegateFromComposer) {
          const location =
            "threadId" in context
              ? { threadId: context.threadId }
              : context.cwd
                ? { cwd: context.cwd }
                : null;
          if (!location) throw new Error(t("Select a workspace to continue.", "请先选择工作区。"));
          const result = await context.client.delegateFromComposer({
            ...common,
            ...location,
            ...(configuration.model ? { model: configuration.model } : {}),
            ...(configuration.thinkingOptionId
              ? { thinkingOptionId: configuration.thinkingOptionId }
              : {}),
          });
          if (disposed || routingScope(options.context()) !== submittingScope) return;
          child = { threadId: result.threadId, hostId: context.hostId };
          delegation = null;
        } else if (
          !configuration &&
          selectedHandoff &&
          "threadId" in context &&
          context.client.sendHandoff
        ) {
          await context.client.sendHandoff({
            ...common,
            threadId: context.threadId,
            revision: selectedHandoff.preview.revision,
          });
          if (disposed || routingScope(options.context()) !== submittingScope) return;
          handoff = null;
        } else {
          throw new Error(t("This Host cannot send the draft.", "当前 Host 无法发送此草稿。"));
        }
        draft.clear();
        attempt = undefined;
        status();
        if (!configuration) options.onHandoff();
        else if (!("threadId" in context) && child) {
          void options.openChild(child.threadId, context.hostId).catch((error) => {
            if (!disposed && scope === submittingScope) fail(error);
          });
        }
      } catch (error) {
        if (disposed || scope !== submittingScope) return;
        fail(
          error,
          configuration
            ? t(
                "Open the delegation tag to reselect the configuration.",
                "点击委派标签可重新选择配置。",
              )
            : t("Review the handoff again or cancel it.", "请重新查看交接或取消切换。"),
        );
      } finally {
        pending = false;
        if (!disposed) draw();
      }
    })();
    return true;
  };

  status();
  draw();
  return {
    openHandoff,
    configureDelegation,
    sync() {
      preloadCodexCatalog(options.context());
      if (scope === undefined) return;
      if (scope === routingScope(options.context())) {
        syncDelegationCatalog?.();
        return;
      }
      scope = undefined;
      syncDelegationCatalog = undefined;
      generation += 1;
      panelKind = null;
      root.append(notice);
      panel.replaceChildren();
      delegation = null;
      handoff = null;
      child = null;
      attempt = undefined;
      status();
      draw();
    },
    submit,
    dispose() {
      disposed = true;
      generation += 1;
      syncDelegationCatalog = undefined;
      unsubscribeCatalog();
      root.remove();
      panel.remove();
    },
  };
}
