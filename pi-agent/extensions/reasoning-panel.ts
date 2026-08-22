/**
 * Reasoning Panel Extension
 *
 * Shows the model's raw reasoning in a panel BELOW the editor, keeping the main
 * chat clean (it only shows tool calls and the final result).
 *
 * - Raw reasoning streams into the panel and is hidden from the main chat.
 * - /traces toggles the panel (expanded / collapsed).
 * - /modelsm picks a small model shown in the footer status line (informational
 *   only — no API calls are made to it).
 *
 * Note: TUI mode only.
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Selected small model (informational only)
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER = "fireworks";
const DEFAULT_MODEL_ID = "accounts/fireworks/models/deepseek-v4-flash";

let selectedProvider = DEFAULT_PROVIDER;
let selectedModelId = DEFAULT_MODEL_ID;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let panelEnabled = false;
let tuiRef: TUI | null = null;
let themeRef: Theme | null = null;
let reasoning = "";

// Small-model usage counters (currently informational; no calls are made).
let smallInputTokens = 0;
let smallOutputTokens = 0;
let smallCacheReadTokens = 0;
let smallCacheWriteTokens = 0;
let smallCost = 0;

// ---------------------------------------------------------------------------
// Panel component (widget below the editor)
// ---------------------------------------------------------------------------

class ReasoningPanel {
  constructor(private theme: Theme) {}

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    lines.push(
      panelEnabled
        ? th.fg("accent", "traces [expanded]")
        : th.fg("muted", "traces [collapsed]"),
    );

    if (!panelEnabled) return lines;

    const raw = reasoning.trim();
    if (raw) {
      const termRows = tuiRef?.terminal?.rows ?? 24;
      const maxBodyLines = Math.max(3, Math.floor(termRows * 0.3) - 2);
      const wrapped = wrapTextWithAnsi(raw, Math.max(10, width - 2));
      const shown = wrapped.slice(-maxBodyLines);
      for (const line of shown) {
        lines.push(`  ${truncateToWidth(line, Math.max(4, width - 2), "...")}`);
      }
      if (wrapped.length > maxBodyLines) {
        lines.push(th.fg("dim", "  …"));
      }
    } else {
      lines.push(th.fg("dim", "· waiting for reasoning"));
    }

    return lines;
  }

  invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requestRender(): void {
  try {
    tuiRef?.requestRender();
  } catch {
    // TUI may be torn down; ignore.
  }
}

function mountPanel(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  ctx.ui.setWidget(
    "reasoning-panel",
    (tui, theme) => {
      tuiRef = tui;
      themeRef = theme;
      return new ReasoningPanel(theme);
    },
    { placement: "belowEditor" },
  );
}

function findSelectedModel(ctx: ExtensionContext) {
  const exact = ctx.modelRegistry.find(selectedProvider, selectedModelId);
  if (exact) return exact;
  const suffix = selectedModelId.split("/").pop();
  return ctx.modelRegistry
    .getAvailable()
    .find((model) => model.provider === selectedProvider && suffix !== undefined && model.id.endsWith(`/${suffix}`));
}

function formatUsd(value: number | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "$?";
}

function costLabel(model: { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }): string {
  const c = model.cost;
  if (!c) return "$?/$?";
  const parts = [`in ${formatUsd(c.input)}`, `out ${formatUsd(c.output)}`];
  if (typeof c.cacheRead === "number" && c.cacheRead > 0) parts.push(`R ${formatUsd(c.cacheRead)}`);
  if (typeof c.cacheWrite === "number" && c.cacheWrite > 0) parts.push(`W ${formatUsd(c.cacheWrite)}`);
  return parts.join(" · ");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const h = home.replace(/\\/g, "/");
  const c = cwd.replace(/\\/g, "/");
  if (c === h) return "~";
  if (c.startsWith(`${h}/`)) return `~/${c.slice(h.length + 1)}`;
  return cwd;
}

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type UsageLike = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };

function createTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: Totals, usage?: UsageLike): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

/**
 * Renders pi's native footer (one pass over session usage) plus a small-model
 * line directly below the primary line, in the same left/right muted style.
 */
class ReasoningFooter {
  constructor(
    private ctx: ExtensionContext,
    private footerData: ReadonlyFooterDataProvider,
    private theme: Theme,
  ) {}

  private layout(left: string, right: string, width: number): string {
    const th = this.theme;
    let l = visibleWidth(left) > width ? truncateToWidth(left, width, "...") : left;
    let r = right;
    if (visibleWidth(l) + 2 + visibleWidth(r) > width) {
      const avail = width - visibleWidth(l) - 2;
      if (avail > 0) {
        l = truncateToWidth(left, Math.max(0, width - avail - 2), "...");
        r = truncateToWidth(right, avail, "");
      } else {
        r = "";
      }
    }
    const pad = Math.max(2, width - visibleWidth(l) - visibleWidth(r));
    return th.fg("dim", l) + th.fg("dim", " ".repeat(pad) + r);
  }

  render(width: number): string[] {
    const th = this.theme;
    const ctx = this.ctx;
    const lines: string[] = [];

    // One pass over session usage for the primary line.
    const totals = createTotals();
    let hitRate: number | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      const e = entry as { type: string; message?: { role?: string; usage?: UsageLike }; usage?: UsageLike };
      if (e.type === "message") {
        const msg = e.message;
        if (msg?.role === "assistant") {
          addUsage(totals, msg.usage);
          const prompt = (msg.usage?.input ?? 0) + (msg.usage?.cacheRead ?? 0) + (msg.usage?.cacheWrite ?? 0);
          if (prompt > 0) hitRate = ((msg.usage?.cacheRead ?? 0) / prompt) * 100;
        } else if (msg?.role === "toolResult" && msg.usage) {
          addUsage(totals, msg.usage);
        }
      } else if (e.type === "branch_summary" || e.type === "compaction") {
        addUsage(totals, e.usage);
      }
    }

    const primary = ctx.model;
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? primary?.contextWindow ?? 0;
    const percent = usage?.percent != null ? usage.percent.toFixed(1) : "?";

    // cwd/branch/session line
    let pwd = formatCwd(ctx.cwd);
    const branch = this.footerData.getGitBranch();
    if (branch) pwd = `${pwd} (${branch})`;
    const sessionName = ctx.sessionManager.getSessionName?.();
    if (sessionName) pwd = `${pwd} • ${sessionName}`;
    lines.push(truncateToWidth(th.fg("dim", pwd), width, th.fg("dim", "...")));

    // Primary model line
    const parts: string[] = [];
    if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
    if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
    if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
    if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
    if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && hitRate !== undefined) parts.push(`CH${hitRate.toFixed(1)}%`);
    if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
    const contextDisplay = percent === "?" ? `?/${formatTokens(window)}` : `${percent}%/${formatTokens(window)}`;
    parts.push(`${contextDisplay} (auto)`);

    let primaryRight = primary?.id ?? "no-model";
    if (primary?.reasoning) {
      const level = ctx.thinkingLevel || "off";
      primaryRight = level === "off" ? `${primaryRight} • thinking off` : `${primaryRight} • ${level}`;
    }
    if (this.footerData.getAvailableProviderCount() > 1 && primary) {
      primaryRight = `(${primary.provider}) ${primaryRight}`;
    }
    lines.push(this.layout(parts.join(" "), `prime • ${primaryRight}`, width));

    // Small model line (tokens/cost left, model right), matches the line above.
    const small = findSelectedModel(ctx);
    if (small) {
      const smallLeftParts = [`↑${formatTokens(smallInputTokens)}`, `↓${formatTokens(smallOutputTokens)}`];
      if (smallCacheReadTokens) smallLeftParts.push(`R${formatTokens(smallCacheReadTokens)}`);
      if (smallCacheWriteTokens) smallLeftParts.push(`W${formatTokens(smallCacheWriteTokens)}`);
      smallLeftParts.push(`$${smallCost.toFixed(3)}`);

      let smallRight = small.id;
      if (small.reasoning) smallRight = `${smallRight} • thinking off`;
      if (this.footerData.getAvailableProviderCount() > 1) smallRight = `(${small.provider}) ${smallRight}`;

      lines.push(this.layout(smallLeftParts.join(" "), `small • ${smallRight}`, width));
    }

    // Remaining extension statuses.
    const statuses = this.footerData.getExtensionStatuses();
    if (statuses.size > 0) {
      const sorted = Array.from(statuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(text));
      lines.push(truncateToWidth(sorted.join(" "), width, th.fg("dim", "...")));
    }

    return lines;
  }

  invalidate(): void {}
}

function mountFooter(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    tuiRef = tui;
    themeRef = theme;
    return new ReasoningFooter(ctx, footerData, theme);
  });
}

async function pickModel(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Model picker requires an interactive UI.", "warning");
    return;
  }

  const models = ctx.modelRegistry.getAvailable();
  if (models.length === 0) {
    ctx.ui.notify("No models are currently available.", "warning");
    return;
  }

  const options = models.map((model) => `${model.name}  ·  ${costLabel(model)}  ·  ${model.id}`);
  const choice = await ctx.ui.select("Small model", options);
  if (!choice) return;

  const model = models[options.indexOf(choice)];
  if (!model) return;

  selectedProvider = model.provider;
  selectedModelId = model.id;
  requestRender();
  ctx.ui.notify(`Small model: ${model.provider}/${model.id}`, "info");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Keep raw thinking out of the main chat (display-only change).
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType === "assistant-thinking") return "";
    return markdown;
  });

  // Mount the panel (collapsed by default) and footer once the session/UI is ready.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    mountPanel(ctx);
    mountFooter(ctx);
  });

  // New agent run: reset the trace.
  pi.on("agent_start", () => {
    reasoning = "";
    requestRender();
  });

  // Stream reasoning into the panel.
  pi.on("message_update", (_event) => {
    const event = _event.assistantMessageEvent;
    if (event.type === "thinking_delta") {
      reasoning += event.delta;
      requestRender();
    }
  });

  // Clean up on session teardown.
  pi.on("session_shutdown", () => {
    tuiRef = null;
    themeRef = null;
    reasoning = "";
    smallInputTokens = 0;
    smallOutputTokens = 0;
    smallCacheReadTokens = 0;
    smallCacheWriteTokens = 0;
    smallCost = 0;
  });

  // Toggle command.
  pi.registerCommand("trace", {
    description: "Toggle the reasoning panel",
    handler: async (_args, ctx) => {
      panelEnabled = !panelEnabled;
      requestRender();
      ctx.ui.notify(panelEnabled ? "Traces: expanded" : "Traces: collapsed", "info");
    },
  });

  // Pick the small model shown in the footer.
  pi.registerCommand("modelsm", {
    description: "Pick the small model shown in the footer",
    handler: async (_args, ctx) => {
      await pickModel(ctx);
    },
  });
}
