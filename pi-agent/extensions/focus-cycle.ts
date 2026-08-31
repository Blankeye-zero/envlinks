/**
 * Focus Cycle — Tab-driven focus rotation:
 *
 *   input area ──[tab]──▶ chat history ──[tab]──▶ reasoning traces ──[tab]──▶ notes ──[tab]──▶ input area
 *
 * - Press [Tab] in the *empty* input editor to enter browse mode on the chat panel.
 *   (When the editor has text, Tab keeps its normal autocomplete behavior.)
 * - Peruse with vim keys: j/k (or arrows) scroll, ctrl+d/u half-page, g/G top/bottom.
 * - [Tab] cycles chat → reasoning → notes → back to the input area (shift+tab reverses).
 *   h/l also switch panels. The notes panel shows the workspace's .pi/notes.md
 *   (read-only viewer; manage via /notes, quick-add via /note <text>).
 * - [Esc] or q returns to the input area from anywhere.
 *
 * Keys while browsing:
 *
 *   | Key               | Action                                  |
 *   |-------------------|-----------------------------------------|
 *   | j / k, arrows     | scroll line down/up                     |
 *   | ctrl+j / ctrl+k   | half-page down/up                       |
 *   | pageDown/pageUp   | half-page down/up                       |
 *   | g / G, home/end   | top / bottom (re-pin to latest)         |
 *   | h / l             | switch to chat / reasoning panel        |
 *   | tab / shift+tab   | next / previous panel (notes → input)   |
 *   | r                 | refresh current panel                   |
 *   | esc / q / ctrl+c  | back to input area                      |
 *
 * Also provides the /browse command (optional argument: "chat", "reasoning", or "notes").
 *
 * Notes:
 * - The browser is a full-screen overlay rebuilt from the session, so it works in
 *   both inline and --tui-mode fullscreen rendering.
 * - Content refreshes live while the agent is streaming; the view sticks to the
 *   bottom until you scroll up (press G or End to re-pin to the latest output).
 */

import { getMarkdownTheme, Theme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isKittyProtocolActive,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { readNotes } from "./notepad.ts";

type Panel = "chat" | "reasoning" | "notes";

/** Tab cycle order; the final next/prev step returns to the input area. */
const PANELS: Panel[] = ["chat", "reasoning", "notes"];

/** Minimal structural typing over pi-ai content blocks. */
interface ContentPart {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content as ContentPart[]) {
		if (part.type === "text" && part.text) parts.push(part.text);
		else if (part.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function fmtTime(iso: unknown): string {
	if (typeof iso !== "string") return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Match ctrl+j. In legacy terminals (no Kitty keyboard protocol) ctrl+j sends
 * the same byte as Enter ("\n"), so we only treat "\n" as ctrl+j when the
 * Kitty protocol makes them distinguishable; otherwise plain Enter would
 * scroll. Use pageUp/pageDown as the fallback there.
 */
function isCtrlJ(data: string): boolean {
	if (data === "\n" && !isKittyProtocolActive()) return false;
	return matchesKey(data, "ctrl+j");
}

function summarizeArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	let s: string;
	try {
		s = JSON.stringify(args);
	} catch {
		return "";
	}
	s = s.replace(/\s+/g, " ").trim();
	return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export class BrowserComponent implements Component {
	private panel: Panel;
	private scrollTop = 0;
	/** Stick to the bottom (latest content) until the user scrolls up. */
	private follow = true;
	private cache: { panel: Panel; width: number; lines: string[] } | undefined;
	private dirty = true;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly ctx: ExtensionContext,
		private readonly onClose: () => void,
		startPanel: Panel = "chat",
	) {
		this.panel = startPanel;
	}

	/** Called by the extension when new session content arrives while browsing. */
	refresh(): void {
		this.dirty = true;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.dirty = true;
	}

	private setPanel(panel: Panel): void {
		if (this.panel === panel) return;
		this.panel = panel;
		this.scrollTop = 0;
		this.follow = true;
	}

	private nextPanel(): void {
		const idx = PANELS.indexOf(this.panel);
		if (idx >= PANELS.length - 1) {
			this.onClose();
			return;
		}
		this.setPanel(PANELS[idx + 1] ?? "chat");
	}

	private prevPanel(): void {
		const idx = PANELS.indexOf(this.panel);
		if (idx <= 0) {
			this.onClose();
			return;
		}
		this.setPanel(PANELS[idx - 1] ?? "chat");
	}

	handleInput(data: string): void {
		const halfPage = () => Math.max(1, Math.floor((this.tui.terminal.rows - 4) / 2));

		if (matchesKey(data, "tab")) {
			this.nextPanel();
		} else if (matchesKey(data, "shift+tab")) {
			this.prevPanel();
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
			return;
		} else if (data === "j" || matchesKey(data, "down")) {
			this.follow = false;
			this.scrollTop += 1;
		} else if (data === "k" || matchesKey(data, "up")) {
			this.follow = false;
			this.scrollTop -= 1;
		} else if (data === "h") {
			this.setPanel("chat");
		} else if (data === "l") {
			this.setPanel("reasoning");
		} else if (isCtrlJ(data) || matchesKey(data, "pageDown")) {
			this.follow = false;
			this.scrollTop += halfPage();
		} else if (matchesKey(data, "ctrl+k") || matchesKey(data, "pageUp")) {
			this.follow = false;
			this.scrollTop -= halfPage();
		} else if (data === "g" || matchesKey(data, "home")) {
			this.follow = false;
			this.scrollTop = 0;
		} else if (data === "G" || matchesKey(data, "end")) {
			this.follow = true;
		} else if (data === "r") {
			this.dirty = true; // manual refresh (e.g. notes file edited externally)
		} else {
			return; // ignore everything else while browsing
		}
		this.tui.requestRender();
	}

	private contentLines(width: number): string[] {
		if (!this.dirty && this.cache && this.cache.width === width && this.cache.panel === this.panel) {
			return this.cache.lines;
		}
		const lines =
			this.panel === "chat"
				? this.buildChat(width)
				: this.panel === "reasoning"
					? this.buildReasoning(width)
					: this.buildNotes(width);
		this.cache = { panel: this.panel, width, lines };
		this.dirty = false;
		return lines;
	}

	private buildChat(width: number): string[] {
		const t = this.theme;
		const mdTheme = getMarkdownTheme();
		const out: string[] = [];
		const inner = Math.max(8, width - 2);

		const pushPlain = (s: string) => {
			for (const line of s.split("\n")) out.push(truncateToWidth(line, width));
		};
		const pushMd = (md: string) => {
			try {
				for (const line of new Markdown(md, 1, 0, mdTheme).render(inner)) {
					out.push(truncateToWidth(line, width));
				}
			} catch {
				pushPlain(md);
			}
		};

		let messages = 0;
		for (const entry of this.ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const msg = (entry as unknown as { message: Record<string, unknown> }).message;
				const time = fmtTime((entry as { timestamp?: unknown }).timestamp);

				switch (msg.role) {
					case "user": {
						const text = textOf(msg.content).trim();
						if (!text) break;
						out.push("");
						out.push(t.fg("accent", t.bold("❯ you")) + t.fg("dim", `  ${time}`));
						pushMd(text);
						messages++;
						break;
					}
					case "assistant": {
						out.push("");
						const model = typeof msg.model === "string" ? ` · ${msg.model}` : "";
						out.push(t.fg("success", t.bold("● assistant")) + t.fg("dim", `  ${time}${model}`));
						for (const part of (msg.content ?? []) as ContentPart[]) {
							if (part.type === "text" && part.text?.trim()) {
								pushMd(part.text);
							} else if (part.type === "thinking" && part.thinking?.trim()) {
								out.push(t.fg("dim", "  ✻ thinking… (tab → reasoning panel)"));
							} else if (part.type === "toolCall") {
								out.push(t.fg("muted", `  ⚙ ${part.name}`) + t.fg("dim", ` ${summarizeArgs(part.arguments)}`));
							}
						}
						messages++;
						break;
					}
					case "toolResult": {
						const first = textOf(msg.content)
							.split("\n")
							.find((l) => l.trim().length > 0);
						const summary = first ? first.trim().slice(0, 120) : "(no output)";
						const err = msg.isError ? t.fg("error", "✗ ") : "";
						out.push(t.fg("dim", `  ⎿ ${String(msg.toolName)}: `) + err + t.fg("muted", summary));
						break;
					}
					case "bashExecution": {
						out.push("");
						out.push(t.fg("bashMode", t.bold(`! ${String(msg.command ?? "")}`)));
						const output = String(msg.output ?? "").trim();
						if (output) {
							const head = output.split("\n").slice(0, 5).join("\n");
							pushPlain(t.fg("dim", head));
						}
						messages++;
						break;
					}
					case "custom": {
						if (msg.display === false) break;
						const text = textOf(msg.content).trim();
						if (!text) break;
						out.push("");
						out.push(t.fg("customMessageLabel", t.bold(`◆ ${String(msg.customType)}`)));
						pushPlain(text);
						messages++;
						break;
					}
					case "branchSummary":
					case "compactionSummary": {
						out.push("");
						const label = msg.role === "branchSummary" ? "branch summary" : "compaction summary";
						out.push(t.fg("warning", `― ${label} ―`));
						pushPlain(t.fg("dim", String(msg.summary ?? "")));
						break;
					}
				}
			} else if (entry.type === "compaction") {
				out.push("");
				out.push(t.fg("warning", "― context compacted ―"));
			} else if (entry.type === "custom_message") {
				const e = entry as { customType?: string; content?: unknown; display?: boolean };
				if (e.display === false) continue;
				const text = textOf(e.content).trim();
				if (!text) continue;
				out.push("");
				out.push(t.fg("customMessageLabel", t.bold(`◆ ${e.customType ?? "custom"}`)));
				pushPlain(text);
			}
		}

		if (messages === 0) {
			out.push("");
			pushPlain(t.fg("dim", "  No messages yet. Chat with the agent, then tab back here."));
		}
		return out;
	}

	private buildReasoning(width: number): string[] {
		const t = this.theme;
		const mdTheme = getMarkdownTheme();
		const out: string[] = [];
		const inner = Math.max(8, width - 2);

		const pushMd = (md: string) => {
			try {
				for (const line of new Markdown(md, 1, 0, mdTheme).render(inner)) {
					out.push(truncateToWidth(line, width));
				}
			} catch {
				for (const line of md.split("\n")) out.push(truncateToWidth(line, width));
			}
		};

		let traces = 0;
		for (const entry of this.ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = (entry as unknown as { message: Record<string, unknown> }).message;
			if (msg.role !== "assistant") continue;
			const time = fmtTime((entry as { timestamp?: unknown }).timestamp);
			const model = typeof msg.model === "string" ? ` · ${msg.model}` : "";

			for (const part of (msg.content ?? []) as ContentPart[]) {
				if (part.type !== "thinking" || !part.thinking?.trim()) continue;
				traces++;
				out.push("");
				out.push(
					t.fg("thinkingHigh", t.bold(`━━ reasoning #${traces}`)) + t.fg("dim", `  ${time}${model} ━━`),
				);
				pushMd(part.thinking.trim());
			}
		}

		if (traces === 0) {
			out.push("");
			const hint = t.fg("dim", "  No reasoning traces in this session yet.");
			out.push(hint);
			out.push(t.fg("dim", "  Thinking blocks appear here when the active model produces reasoning."));
		}
		return out;
	}

	private buildNotes(width: number): string[] {
		const t = this.theme;
		const out: string[] = [];
		const inner = Math.max(8, width - 2);
		const raw = readNotes(this.ctx.cwd).trim();

		if (!raw) {
			out.push("");
			out.push(t.fg("dim", "  No notes yet."));
			out.push(t.fg("dim", "  Add one with /note <text>, or manage with /notes"));
			return out;
		}

		out.push("");
		for (const line of raw.split("\n")) {
			for (const wrapped of wrapTextWithAnsi(line, inner)) {
				out.push(truncateToWidth(wrapped, width));
			}
		}
		return out;
	}

	private renderHeader(width: number): string {
		const t = this.theme;
		const tab = (label: string, active: boolean) =>
			active ? t.bg("selectedBg", t.bold(` ${label} `)) : t.fg("dim", ` ${label} `);
		const line = ` ${tab("chat", this.panel === "chat")} ${tab("reasoning", this.panel === "reasoning")} ${tab("notes", this.panel === "notes")}`;
		const pad = Math.max(0, width - visibleWidth(line));
		return line + " ".repeat(pad);
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = Math.max(10, this.tui.terminal.rows);
		const cols = Math.max(20, width);
		const viewport = rows - 4;

		const lines = this.contentLines(cols);
		const maxScroll = Math.max(0, lines.length - viewport);
		if (this.follow) this.scrollTop = maxScroll;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));

		const sep = t.fg("borderMuted", "─".repeat(cols));
		const body = lines.slice(this.scrollTop, this.scrollTop + viewport);
		while (body.length < viewport) body.push("");

		const pct =
			maxScroll === 0
				? "all"
				: this.scrollTop >= maxScroll
					? "end"
					: `${Math.round((this.scrollTop / maxScroll) * 100)}%`;
		const status = t.fg("dim", ` ${lines.length} lines · ${pct}`);
		const helpText =
			this.panel === "notes"
				? "  j/k scroll · g/G top/bottom · tab next · r refresh · /notes manage · esc/q input"
				: "  j/k scroll · ctrl+j/k half-page · g/G top/bottom · h/l chat/reasoning · tab next · esc/q input";
		const help = t.fg("dim", helpText);

		return [this.renderHeader(cols), sep, ...body, sep, status + help].map((l) => truncateToWidth(l, cols));
	}
}

export default function (pi: ExtensionAPI) {
	let browsing = false;
	// True while any extension UI prompt is open (select/confirm/input/editor/custom).
	// Guarded so Tab inside a dialog (e.g. the /notes editor) doesn't open the
	// browser overlay on top and invisibly steal the dialog's keyboard focus.
	let promptActive = false;
	let activeBrowser: BrowserComponent | undefined;
	let unsubscribeInput: (() => void) | undefined;

	async function openBrowser(ctx: ExtensionContext, panel: Panel): Promise<void> {
		if (browsing || ctx.mode !== "tui") return;
		browsing = true;
		try {
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) => {
					const browser = new BrowserComponent(tui, theme, ctx, () => done(null), panel);
					activeBrowser = browser;
					return browser;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						anchor: "top-left",
					},
				},
			);
		} finally {
			browsing = false;
			activeBrowser = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Rebind defensively in case of repeated starts without shutdown.
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			// While the browser overlay is open it owns the keyboard.
			if (browsing) return undefined;
			// A dialog/prompt is open → leave its keys alone.
			if (promptActive) return undefined;
			if (!matchesKey(data, "tab")) return undefined;
			// Editor has content → keep Tab as autocomplete.
			if (ctx.ui.getEditorText().length > 0) return undefined;

			void openBrowser(ctx, "chat");
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		activeBrowser = undefined;
		browsing = false;
	});

	// Track extension UI prompts (coalesced outer span) for the Tab guard above.
	pi.on("ui_prompt_start", () => {
		promptActive = true;
	});
	pi.on("ui_prompt_end", () => {
		promptActive = false;
	});

	// Live-refresh the browser while the agent streams.
	pi.on("message_end", () => activeBrowser?.refresh());
	pi.on("tool_execution_end", () => activeBrowser?.refresh());

	// Live-refresh the notes panel when notepad.ts appends a note via /note.
	pi.events.on("notepad:changed", () => activeBrowser?.refresh());

	pi.registerCommand("browse", {
		description: "Browse chat history, reasoning traces, and workspace notes (hjkl scroll, tab cycles panels)",
		getArgumentCompletions: (prefix) => {
			const items = ["chat", "reasoning", "notes"].filter((v) => v.startsWith(prefix));
			return items.length > 0 ? items.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			const panel: Panel = arg === "reasoning" ? "reasoning" : arg === "notes" ? "notes" : "chat";
			await openBrowser(ctx, panel);
		},
	});
}
