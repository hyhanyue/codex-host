import {
  accountCreditsWindowLabel,
  type AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";

import type { ComposerQuotaSources, ComposerQuotaView } from "./renderer-composer-quota.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

import {
  applyRendererPopoverChrome,
  createRendererUsageRing,
  formatRendererCreditsPercent,
} from "./renderer-usage-control.js";
import {
  applyRendererTriggerChipSqueezeRoot,
  applyRendererTriggerChipSqueezeTrigger,
  ensureRendererTriggerChipStyle,
  rendererCreditsTriggerMaxWidth,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

export interface RendererCreditsControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  update(
    credits: AccountCreditsSnapshot | null,
    locale: RendererSettingsLocale,
    sources?: ComposerQuotaSources,
  ): boolean;
  dispose(): void;
  place(anchor: HTMLElement | null): boolean;
}

export type RendererCreditsTone = "ok" | "warn" | "hot";

export function rendererCreditsTone(usedPercent: number): RendererCreditsTone {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

interface RendererCreditsMessages {
  readonly remaining: string;
  readonly resets: string;
  readonly details: string;
  readonly weekly: string;
  readonly monthly: string;
  readonly fiveHour: string;
  readonly sevenDay: string;
  readonly account: string;
}

const ENGLISH_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
  remaining: "Remaining",
  resets: "Resets",
  details: "Account limit details",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
  fiveHour: "5-hour limit",
  sevenDay: "7-day limit",
  account: "Account limit",
});

const CHINESE_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
  remaining: "剩余",
  resets: "重置",
  details: "账号额度详情",
  weekly: "周额度",
  monthly: "月额度",
  fiveHour: "5 小时额度",
  sevenDay: "7 天额度",
  account: "账号额度",
});

function rendererCreditsMessages(locale: RendererSettingsLocale): RendererCreditsMessages {
  return locale === "zh-CN" ? CHINESE_CREDITS_MESSAGES : ENGLISH_CREDITS_MESSAGES;
}

/**
 * Keep the source's minute precision, while making same-day resets easier to
 * scan and formatting both English and Chinese popovers in one presentation layer.
 */
export function formatRendererCreditsReset(
  value: string,
  now: Date = new Date(),
  locale: RendererSettingsLocale = "en",
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return date.toLocaleDateString(locale, { month: "long", day: "numeric", timeZone: "UTC" });
  }
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    const time = date.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return locale === "zh-CN" ? `今天 ${time}` : `${time} today`;
  }
  return date.toLocaleString(locale === "zh-CN" ? "zh-CN" : undefined, {
    month: locale === "zh-CN" ? "long" : "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function creditsPeriodLabel(
  periodType: AccountCreditsSnapshot["periodType"],
  locale: RendererSettingsLocale = "en",
): string {
  const messages = rendererCreditsMessages(locale);
  if (periodType === "weekly") return messages.weekly;
  if (periodType === "monthly") return messages.monthly;
  if (periodType === "five_hour") return messages.fiveHour;
  if (periodType === "seven_day") return messages.sevenDay;
  return messages.account;
}

export function productLabel(
  product: AccountCreditsSnapshot | NonNullable<AccountCreditsSnapshot["productUsage"]>[number],
  locale: RendererSettingsLocale = "en",
): string {
  return accountCreditsWindowLabel(product, locale, (period) => creditsPeriodLabel(period, locale));
}

function toneColor(tone: RendererCreditsTone): string {
  if (tone === "hot") return "#c45c4a";
  if (tone === "warn") return "#c9a227";
  return "#3d9a64";
}

function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

function renderCreditsBar(usagePercent: number, color: string): HTMLDivElement {
  const track = document.createElement("div");
  track.dataset.codexhostCreditsBar = "";
  track.style.height = "6px";
  track.style.borderRadius = "9999px";
  track.style.background = "color-mix(in srgb, currentColor 16%, transparent)";
  track.style.overflow = "hidden";
  const fill = document.createElement("span");
  fill.style.display = "block";
  fill.style.height = "100%";
  fill.style.borderRadius = "9999px";
  fill.style.width = `${Math.min(100, Math.max(0, usagePercent))}%`;
  fill.style.background = color;
  track.append(fill);
  return track;
}

function resetLabel(
  resetsAt: string,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
): string {
  const formatted = formatRendererCreditsReset(resetsAt, new Date(), locale);
  return locale === "zh-CN" ? `${formatted} ${messages.resets}` : `${messages.resets} ${formatted}`;
}

function renderCreditsTile(
  label: string,
  usagePercent: number,
  locale: RendererSettingsLocale,
  amount: Pick<AccountCreditsSnapshot, "used" | "limit" | "unit" | "resetsAt">,
  leading = false,
): HTMLDivElement {
  const messages = rendererCreditsMessages(locale);
  const color = toneColor(rendererCreditsTone(usagePercent));
  const remaining = remainingPercent(usagePercent);
  const hasCap = amount.limit !== 0;

  const tile = document.createElement("div");
  tile.style.marginBottom = "11px";

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "flex-start";
  top.style.justifyContent = "space-between";
  top.style.gap = "12px";
  top.style.marginBottom = "5px";

  const left = document.createElement("div");
  const name = document.createElement("div");
  name.textContent = label;
  name.style.fontSize = leading ? "12.5px" : "12px";
  if (leading) name.style.fontWeight = "600";
  left.append(name);
  if (amount.resetsAt) {
    const reset = document.createElement("div");
    reset.textContent = resetLabel(amount.resetsAt, locale, messages);
    reset.style.fontSize = "11px";
    reset.style.opacity = "0.7";
    left.append(reset);
  }

  const percent = document.createElement("span");
  percent.style.display = "inline-flex";
  percent.style.alignItems = "baseline";
  percent.style.gap = "4px";
  percent.style.whiteSpace = "nowrap";
  percent.style.color = color;
  if (leading) {
    const caption = document.createElement("span");
    caption.textContent = `${messages.remaining} `;
    caption.style.fontSize = "11px";
    caption.style.fontWeight = "600";
    const value = document.createElement("span");
    value.textContent = hasCap ? formatRendererCreditsPercent(remaining) : "—";
    value.style.fontSize = "26px";
    value.style.fontWeight = "700";
    value.style.fontVariantNumeric = "tabular-nums";
    percent.append(caption, value);
  } else {
    percent.textContent = `${messages.remaining} ${hasCap ? formatRendererCreditsPercent(remaining) : "—"}`;
    percent.style.fontSize = "12px";
    percent.style.fontVariantNumeric = "tabular-nums";
  }
  top.append(left, percent);
  tile.append(top);
  if (hasCap) tile.append(renderCreditsBar(remaining, color));
  if (amount.used !== undefined && amount.limit !== undefined && amount.unit) {
    const detail = document.createElement("div");
    const available = Math.max(0, amount.limit - amount.used);
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
    detail.textContent = `${format.format(available)} / ${format.format(amount.limit)} ${amount.unit}`;
    detail.style.fontSize = "11px";
    detail.style.marginTop = "4px";
    tile.append(detail);
  }
  return tile;
}

function renderDetails(
  content: HTMLElement,
  credits: AccountCreditsSnapshot,
  locale: RendererSettingsLocale,
): void {
  const tiles = [
    renderCreditsTile(productLabel(credits, locale), credits.usedPercent, locale, credits, true),
    ...(credits.productUsage ?? []).map((product) =>
      renderCreditsTile(productLabel(product, locale), product.usagePercent, locale, product),
    ),
  ];
  const lastTile = tiles.at(-1);
  if (lastTile) lastTile.style.marginBottom = "0";
  content.append(...tiles);
}

const QUOTA_STATUS = {
  loading: ["Loading limits…", "正在读取额度…"],
  empty: ["No limit data available", "暂无额度数据"],
  unsupported: ["Account limits are unavailable for this Agent", "此 Agent 未提供可读取的账户额度"],
  notInstalled: ["The CLI is not installed", "CLI 未安装"],
  authenticationRequired: ["Sign in to this Agent to see its limits", "请登录此 Agent 后查看额度"],
  failed: ["Could not refresh limits", "额度刷新失败"],
} as const;

function quotaButton(text: string, label?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = TRIGGER_CHIP_CLASS;
  button.textContent = text;
  if (label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  button.style.padding = "4px 6px";
  button.style.fontSize = "11px";
  button.style.whiteSpace = "nowrap";
  return button;
}

function popoverIsOpen(popover: HTMLDivElement): boolean {
  try {
    return popover.matches(":popover-open");
  } catch {
    return !popover.hidden;
  }
}

function positionPopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  const triggerRect = control.trigger.getBoundingClientRect();
  const width = Math.min(280, Math.max(220, window.innerWidth - 24));
  const left = Math.max(12, Math.min(triggerRect.left, window.innerWidth - width - 12));
  control.popover.style.width = `${width}px`;
  control.popover.style.left = `${left}px`;
  control.popover.style.right = "auto";
  control.popover.style.top = "auto";
  control.popover.style.bottom = `${Math.max(12, window.innerHeight - triggerRect.top + 8)}px`;
}

function closePopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  if (popoverIsOpen(control.popover) && typeof control.popover.hidePopover === "function") {
    control.popover.hidePopover();
  }
  control.popover.hidden = true;
  control.trigger.setAttribute("aria-expanded", "false");
}

function openPopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  positionPopover(control);
  control.popover.hidden = false;
  if (typeof control.popover.showPopover === "function" && !popoverIsOpen(control.popover)) {
    control.popover.showPopover();
  }
  control.trigger.setAttribute("aria-expanded", "true");
}

function togglePopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  if (control.trigger.getAttribute("aria-expanded") === "true") closePopover(control);
  else openPopover(control);
}

export function mountRendererCreditsControl(composerId: string): RendererCreditsControl {
  ensureRendererTriggerChipStyle(document);

  const root = document.createElement("div");
  root.dataset.codexhostCreditsControl = composerId;
  root.className = "relative min-w-0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.height = "28px";
  root.style.verticalAlign = "middle";
  applyRendererTriggerChipSqueezeRoot(root, rendererCreditsTriggerMaxWidth(), "40px");

  const trigger = document.createElement("button");
  trigger.className = TRIGGER_CHIP_CLASS;
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Account limit");
  trigger.title = "Account limit";
  trigger.style.gap = "5px";
  applyRendererTriggerChipSqueezeTrigger(trigger);
  // Match the 28px height shared by the Model/Permission-mode/Agent triggers
  // it sits next to — a shorter box here previously threw off the row's
  // vertical alignment (visible as Credits sitting a few px lower than its
  // neighbors), whether the host lays this row out as flex or inline content.
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.verticalAlign = "middle";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";

  const ringSlot = document.createElement("span");
  ringSlot.dataset.codexhostCreditsRing = "";
  ringSlot.style.display = "inline-flex";
  ringSlot.style.flex = "0 0 auto";

  const label = document.createElement("span");
  label.dataset.codexhostCreditsLabel = "";
  label.style.display = "inline-block";
  label.style.maxWidth = "100%";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(ringSlot, label);

  const popover = document.createElement("div");
  popover.id = `${composerId}-credits-popover`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Account limit details");
  popover.setAttribute("popover", "auto");
  popover.hidden = typeof popover.showPopover !== "function";
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.width = "240px";
  popover.style.maxWidth = "min(280px, calc(100vw - 24px))";
  popover.style.padding = "10px 12px";
  popover.style.maxHeight = "min(65vh, 440px)";
  popover.style.overflow = "auto";
  applyRendererPopoverChrome(popover);
  popover.style.font = "13px/1.35 system-ui, sans-serif";
  popover.style.letterSpacing = "0";
  popover.style.zIndex = "2147483647";
  trigger.setAttribute("aria-controls", popover.id);

  const navigation = document.createElement("div");
  navigation.style.display = "flex";
  navigation.style.flexWrap = "wrap";
  navigation.style.gap = "3px";
  navigation.style.marginBottom = "10px";
  const content = document.createElement("div");
  content.setAttribute("aria-live", "polite");
  popover.append(navigation, content);

  let placementReference: Element | null = null;
  let sources: ComposerQuotaSources | undefined;
  let fallback: AccountCreditsSnapshot | null = null;
  let locale: RendererSettingsLocale = "en";
  let selected: string | undefined;
  let views = new Map<string, ComposerQuotaView>();
  let pending = new Set<string>();
  let pinned = false;
  let navKey = "";
  let lastContent: readonly unknown[] = [];
  let ringValue: number | null | undefined;

  const currentSource = () => sources?.agents.find(({ id }) => id === sources?.current);
  const selectedSource = () =>
    sources?.agents.find(({ id }) => id === selected) ?? currentSource() ?? sources?.agents[0];

  const paint = (): boolean => {
    const current = currentSource();
    const active = current && views.get(current.id);
    const useFallback =
      !current || (current.id !== "codex" && (!active || active.status === "loading"));
    const credits = active?.status === "ready" ? active.credits : useFallback ? fallback : null;
    const visible = Boolean((credits || sources?.agents.length) && control.anchor?.parentElement);
    control.root.style.display = visible ? "inline-flex" : "none";
    if (!visible) {
      closePopover(control);
      return false;
    }

    const remaining = credits && credits.limit !== 0 ? remainingPercent(credits.usedPercent) : null;
    const percent = remaining === null ? "—" : formatRendererCreditsPercent(remaining);
    const messages = rendererCreditsMessages(locale);
    const title = credits ? `${productLabel(credits, locale)} ${percent}` : messages.account;
    const description = current ? `${current.label} · ${title}` : title;
    const tone = credits ? toneColor(rendererCreditsTone(credits.usedPercent)) : "currentColor";
    if (ringValue !== remaining || ringSlot.dataset.tone !== tone) {
      ringValue = remaining;
      ringSlot.dataset.tone = tone;
      ringSlot.replaceChildren(
        createRendererUsageRing(remaining ?? 0, {
          size: 14,
          strokeWidth: 2.4,
          color: remaining === null ? "transparent" : tone,
        }),
      );
      label.textContent = remaining === null ? "—" : `${Math.round(remaining)}%`;
    }
    trigger.setAttribute("aria-label", description);
    trigger.title = description;

    const source = selectedSource();
    const view = source ? views.get(source.id) : undefined;
    const shown =
      !source || source.id === current?.id
        ? credits
        : view?.status === "ready"
          ? view.credits
          : null;
    const nextNavKey = JSON.stringify([locale, sources?.agents, source?.id, current?.id]);
    if (navKey !== nextNavKey) {
      navKey = nextNavKey;
      navigation.replaceChildren();
      navigation.hidden = !source;
      navigation.style.display = source ? "flex" : "none";
      if (source) {
        for (const agent of sources?.agents ?? []) {
          const button = quotaButton(agent.label);
          button.dataset.codexhostQuotaAgent = agent.id;
          button.setAttribute("aria-pressed", String(agent.id === source.id));
          if (agent.id === source.id) button.style.fontWeight = "700";
          button.addEventListener("click", () => {
            selected = agent.id;
            read(agent.id, false);
            paint();
            navigation
              .querySelector<HTMLElement>(`[data-codexhost-quota-agent="${agent.id}"]`)
              ?.focus();
          });
          navigation.append(button);
        }
        const refreshLabel = locale === "zh-CN" ? "刷新额度" : "Refresh limits";
        const refresh = quotaButton("↻", refreshLabel);
        refresh.style.marginLeft = "auto";
        refresh.addEventListener("click", () => read(source.id, true));
        navigation.append(refresh);
      }
    }
    const nextContent = [source?.label, shown, view, locale];
    if (nextContent.every((value, index) => value === lastContent[index])) return true;
    lastContent = nextContent;
    popover.setAttribute(
      "aria-label",
      source ? `${source.label} · ${messages.details}` : messages.details,
    );
    const glow = shown && toneColor(rendererCreditsTone(shown.usedPercent));
    popover.style.backgroundImage = glow
      ? `radial-gradient(160px 100px at 18% -10%, color-mix(in srgb, ${glow} 20%, transparent), transparent 70%)`
      : "none";
    content.replaceChildren();
    if (shown) {
      if (view?.status === "ready" && view.plan) {
        const plan = document.createElement("div");
        plan.style.fontSize = "11px";
        plan.style.opacity = "0.7";
        plan.textContent = view.plan;
        content.append(plan);
      }
      renderDetails(content, shown, locale);
    } else if (source) {
      content.textContent =
        QUOTA_STATUS[view?.status === "ready" ? "empty" : (view?.status ?? "loading")][
          locale === "zh-CN" ? 1 : 0
        ];
    }
    return true;
  };

  function read(id: string, refresh: boolean): void {
    const config = sources;
    if (!config || !config.agents.some((agent) => agent.id === id) || pending.has(id)) return;
    const requests = pending;
    requests.add(id);
    if (refresh || !views.has(id)) {
      views.set(id, { status: "loading" });
      paint();
    }
    void Promise.resolve()
      .then(() => config.read(id, refresh))
      .catch((error: unknown): ComposerQuotaView => ({
        status: error instanceof RendererMethodUnavailableError ? "unsupported" : "failed",
      }))
      .then((view) => {
        requests.delete(id);
        if (pending !== requests) return;
        views.set(id, view);
        paint();
      });
  }

  const control: RendererCreditsControl = {
    root,
    trigger,
    popover,
    anchor: null,
    update(credits, nextLocale, nextSources) {
      fallback = credits;
      locale = nextLocale;
      const reset =
        sources?.client !== nextSources?.client || sources?.accountKey !== nextSources?.accountKey;
      const changedAgent = sources?.current !== nextSources?.current;
      const previousCurrent = currentSource()?.id;
      sources = nextSources;
      if (reset) {
        views = new Map();
        pending = new Set();
      }
      if (reset || changedAgent) selected = undefined;
      const current = currentSource();
      if (current && (reset || current.id !== previousCurrent)) read(current.id, false);
      return paint();
    },
    dispose() {
      sources = undefined;
      pending = new Set();
      closePopover(control);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      root.remove();
      popover.remove();
      placementReference = null;
    },
    place(anchor) {
      // Credits sits immediately *before* its anchor (the permission-mode
      // picker) rather than being derived by walking up from the Usage
      // control's current DOM position. Anchoring directly to a
      // renderer-owned, already-tracked element keeps this stable across
      // reconciliation passes instead of re-deriving a different ancestor
      // once the host page's own DOM settles a few seconds after mount.
      if (!anchor?.parentElement) return false;
      const parent = anchor.parentElement;
      if (
        control.anchor === anchor &&
        placementReference === anchor &&
        root.parentElement === parent &&
        root.nextElementSibling === anchor
      ) {
        return true;
      }
      control.anchor = anchor;
      placementReference = anchor;
      if (root !== anchor) parent.insertBefore(root, anchor);
      return true;
    },
  };

  let closeTimer: number | null = null;
  const cancelClose = (): void => {
    if (closeTimer === null) return;
    window.clearTimeout(closeTimer);
    closeTimer = null;
  };
  const scheduleClose = (): void => {
    cancelClose();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (
        !pinned &&
        !trigger.matches(":hover") &&
        !popover.matches(":hover") &&
        !popover.contains(document.activeElement)
      )
        closePopover(control);
    }, 140);
  };

  const reveal = () => {
    if (trigger.getAttribute("aria-expanded") !== "true") {
      selected = undefined;
      const source = selectedSource();
      if (source) read(source.id, false);
      paint();
    }
    openPopover(control);
  };
  trigger.addEventListener("click", () => {
    if (!sources) {
      togglePopover(control);
    } else if (pinned) {
      pinned = false;
      closePopover(control);
    } else {
      pinned = true;
      reveal();
    }
  });
  trigger.addEventListener("pointerenter", () => {
    cancelClose();
    reveal();
  });
  trigger.addEventListener("pointerleave", scheduleClose);
  trigger.addEventListener("focus", () => {
    cancelClose();
    reveal();
  });
  trigger.addEventListener("blur", scheduleClose);
  popover.addEventListener("pointerenter", cancelClose);
  popover.addEventListener("pointerleave", scheduleClose);
  popover.addEventListener("focusout", scheduleClose);
  popover.addEventListener("toggle", () => {
    const open = popoverIsOpen(popover);
    if (!open) pinned = false;
    trigger.setAttribute("aria-expanded", String(open));
  });
  root.append(trigger);
  document.body.append(popover);
  return control;
}

export function renderRendererCreditsControl(
  control: RendererCreditsControl,
  accountCredits: AccountCreditsSnapshot | null,
  locale: RendererSettingsLocale = "en",
  sources?: ComposerQuotaSources,
): boolean {
  return control.update(accountCredits, locale, sources);
}
