/**
 * Reasoning Panel Extension
 *
 * Shows the model's raw reasoning in a panel BELOW the editor, keeping the main
 * chat clean (it only shows tool calls and the final result).
 *
 * - Raw reasoning streams into the panel and is hidden from the main chat.
 * - /traces toggles the panel (expanded / collapsed).
 * - Footer shows split token economics: one line per model used in the session
 *   (labeled prime/worker via devflow config), usage attributed to the model
 *   that produced each message.
 *
 * Note: TUI mode only.
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// DevFlow model roles (prime = planning model, worker = execution model)
// ---------------------------------------------------------------------------

const DEVFLOW_CONFIG_PATH = join(homedir(), ".pi", "agent", "devflow.json");

interface DevflowRefs {
  planner?: string;
  worker?: string;
}

// Mirrors devflow.ts defaults; overridden by devflow.json and devflow:config events.
let devflowRefs: DevflowRefs = {
  planner: "anthropic/claude-fable-5",
  worker: "fireworks/accounts/fireworks/models/kimi-k3",
};

function toRef(value: unknown): string | undefined {
  const ref = value as { provider?: string; id?: string } | undefined;
  return ref?.provider && ref?.id ? `${ref.provider}/${ref.id}` : undefined;
}

function loadDevflowRefs(): void {
  try {
    if (!existsSync(DEVFLOW_CONFIG_PATH)) return;
    const raw = JSON.parse(readFileSync(DEVFLOW_CONFIG_PATH, "utf8")) as { planner?: unknown; worker?: unknown };
    devflowRefs = {
      planner: toRef(raw.planner) ?? devflowRefs.planner,
      worker: toRef(raw.worker) ?? devflowRefs.worker,
    };
  } catch {
    // keep current refs
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let panelEnabled = false;
let tuiRef: TUI | null = null;
let themeRef: Theme | null = null;
let reasoning = "";

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
 * Renders pi's native footer with one usage line per model used in the session,
 * attributing each message's usage to the model that produced it. Lines are
 * labeled plan/worker from the devflow config, prime for the /model selection
 * used in non-plan workloads.
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

    // Per-model usage totals, attributed to the model that produced each message.
    type ModelTotals = Totals & { hitRate?: number };
    const perModel = new Map<string, ModelTotals>();
    const touch = (key: string): ModelTotals => {
      let t = perModel.get(key);
      if (!t) {
        t = { ...createTotals() };
        perModel.set(key, t);
      }
      return t;
    };
    const activeKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
    let lastKey = activeKey;
    for (const entry of ctx.sessionManager.getEntries()) {
      const e = entry as {
        type: string;
        message?: { role?: string; provider?: string; model?: string; usage?: UsageLike };
        usage?: UsageLike;
      };
      if (e.type === "message") {
        const msg = e.message;
        if (msg?.role === "assistant") {
          const key = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : lastKey;
          const t = touch(key);
          addUsage(t, msg.usage);
          const prompt = (msg.usage?.input ?? 0) + (msg.usage?.cacheRead ?? 0) + (msg.usage?.cacheWrite ?? 0);
          if (prompt > 0) t.hitRate = ((msg.usage?.cacheRead ?? 0) / prompt) * 100;
          lastKey = key;
        } else if (msg?.role === "toolResult" && msg.usage) {
          // Nested tool usage (e.g. sub-model calls) attributed to the calling model.
          addUsage(touch(lastKey), msg.usage);
        }
      } else if (e.type === "branch_summary" || e.type === "compaction") {
        addUsage(touch(lastKey), e.usage);
      }
    }
    // Always show the active model, even before it has produced usage.
    touch(activeKey);

    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const percent = usage?.percent != null ? usage.percent.toFixed(1) : "?";

    // cwd/branch/session line
    let pwd = formatCwd(ctx.cwd);
    const branch = this.footerData.getGitBranch();
    if (branch) pwd = `${pwd} (${branch})`;
    const sessionName = ctx.sessionManager.getSessionName?.();
    if (sessionName) pwd = `${pwd} • ${sessionName}`;
    lines.push(truncateToWidth(th.fg("dim", pwd), width, th.fg("dim", "...")));

    // One usage line per model (insertion order = first use in session).
    const providerCount = this.footerData.getAvailableProviderCount();
    for (const [key, t] of perModel) {
      const slash = key.indexOf("/");
      const provider = slash >= 0 ? key.slice(0, slash) : key;
      const id = slash >= 0 ? key.slice(slash + 1) : key;
      const isActive = key === activeKey;

      const parts: string[] = [];
      if (t.input) parts.push(`↑${formatTokens(t.input)}`);
      if (t.output) parts.push(`↓${formatTokens(t.output)}`);
      if (t.cacheRead) parts.push(`R${formatTokens(t.cacheRead)}`);
      if (t.cacheWrite) parts.push(`W${formatTokens(t.cacheWrite)}`);
      if ((t.cacheRead > 0 || t.cacheWrite > 0) && t.hitRate !== undefined) parts.push(`CH${t.hitRate.toFixed(1)}%`);
      if (t.cost) parts.push(`$${t.cost.toFixed(3)}`);
      if (isActive) {
        const contextDisplay = percent === "?" ? `?/${formatTokens(window)}` : `${percent}%/${formatTokens(window)}`;
        parts.push(`${contextDisplay} (auto)`);
      }

      // plan = devflow planner, worker = devflow worker, prime = the active
      // /model selection for non-plan workloads, other = stale leftovers.
      let label: string;
      if (key === devflowRefs.planner) label = "plan";
      else if (key === devflowRefs.worker) label = "worker";
      else if (isActive) label = "prime";
      else label = "other";

      let right = id;
      if (isActive && ctx.model?.reasoning) {
        const level = ctx.thinkingLevel || "off";
        right = level === "off" ? `${right} • thinking off` : `${right} • ${level}`;
      }
      if (providerCount > 1) right = `(${provider}) ${right}`;
      lines.push(this.layout(parts.join(" "), `${label} • ${right}`, width));
    }

    // Remaining extension statuses, rendered as colored chips: devflow first,
    // then the rest alphabetically, separated by a dim middot.
    const statuses = this.footerData.getExtensionStatuses();
    if (statuses.size > 0) {
      const chips = Array.from(statuses.entries())
        .sort(([a], [b]) => (a === "devflow" ? -1 : b === "devflow" ? 1 : a.localeCompare(b)))
        .map(([, text]) => sanitizeStatusText(text));
      lines.push(truncateToWidth(chips.join(th.fg("dim", " · ")), width, th.fg("dim", "...")));
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
    loadDevflowRefs();
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

  // Live devflow config updates (planner/worker labels in the footer).
  pi.events.on("devflow:config", (cfg) => {
    devflowRefs = {
      planner: toRef((cfg as { planner?: unknown })?.planner) ?? devflowRefs.planner,
      worker: toRef((cfg as { worker?: unknown })?.worker) ?? devflowRefs.worker,
    };
    requestRender();
  });
}
