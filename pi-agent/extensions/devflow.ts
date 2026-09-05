/**
 * DevFlow Extension — plan with a strong model, execute with a fast/cheap one.
 *
 * Workflow:
 *   /df               - configure the planning model and the worker model,
 *                       manage named model-combo presets
 *   /preset           - quick preset switching: /preset <name> | save <name> |
 *                       delete <name> | list
 *   /plan (Ctrl+Alt+D) - toggle planning phase:
 *       - switches to the planning model (default: Claude Fable 5)
 *       - disables edit/write tools, blocks destructive shell commands
 *       - the model produces a numbered plan under a "Plan:" header
 *   When the plan is ready devflow serves it on a loopback port and opens it
 *   in your browser as an annotatable document: select any text to attach a
 *   quote+note annotation, then Approve, Request changes, or Dismiss.
 *   Approval switches to the worker model (default: Kimi K3), restores full
 *   tool access, and kicks off execution with the annotations folded into the
 *   kickoff; requested changes go back to the planner to revise. When the
 *   execution run settles, the planner returns as a read-only reviewer that
 *   evaluates the work, and once the review settles the prime model is
 *   restored at idle. Fully self-contained — no other extension, no deps
 *   beyond node builtins.
 *
 * Config (including presets) persists in ~/.pi/agent/devflow.json.
 * Phase state persists in the session (survives /resume).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, type AutocompleteItem } from "@earendil-works/pi-tui";
import { exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Phase = "idle" | "planning" | "executing" | "reviewing";

interface ModelRef {
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
}

interface DevFlowConfig {
	planner: ModelRef;
	worker: ModelRef;
	keepWorkerAfterExecution?: boolean;
	/** Named planner/worker combos for quick switching (/preset). */
	presets?: Record<string, Preset>;
}

/** A saved planner/worker model combo. */
interface Preset {
	planner: ModelRef;
	worker: ModelRef;
	keepWorkerAfterExecution?: boolean;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "devflow.json");
const DEFAULT_CONFIG: DevFlowConfig = {
	planner: { provider: "anthropic", id: "claude-fable-5", thinking: "high" },
	worker: { provider: "fireworks", id: "accounts/fireworks/models/kimi-k3", thinking: "high" },
	presets: {
		default: {
			planner: { provider: "anthropic", id: "claude-fable-5", thinking: "high" },
			worker: { provider: "fireworks", id: "accounts/fireworks/models/kimi-k3", thinking: "high" },
		},
	},
};

// Tools disabled while planning
const PLANNING_DISABLED_TOOLS = new Set(["edit", "write"]);
// Read-only tools guaranteed active while planning
const PLANNING_EXTRA_TOOLS = ["read", "grep", "find", "ls"];

// Destructive shell fragments blocked during planning (bash + powershell)
const DESTRUCTIVE_PATTERNS = [
	/\bremove-item\b/i,
	/\bset-content\b/i,
	/\bout-file\b/i,
	/\bnew-item\b/i,
	/\bmove-item\b/i,
	/\bcopy-item\b/i,
	/\brm\s+-/,
	/\bmv\s/,
	/\bgit\s+(add|commit|push|reset|checkout|restore)\b/i,
	/\b(npm|pnpm|yarn|pip)\s+(install|add|uninstall|remove)\b/i,
	/\bdel\s/i,
];

function isModelRef(value: unknown): value is ModelRef {
	const ref = value as { provider?: unknown; id?: unknown } | null;
	return !!ref && typeof ref.provider === "string" && typeof ref.id === "string";
}

/** Validated preset entries from a parsed config file (bad entries are dropped). */
function parsePresets(value: unknown): Record<string, Preset> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, Preset> = {};
	for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
		const preset = entry as { planner?: unknown; worker?: unknown; keepWorkerAfterExecution?: unknown } | null;
		if (isModelRef(preset?.planner) && isModelRef(preset?.worker)) {
			out[name] = {
				planner: preset.planner,
				worker: preset.worker,
				keepWorkerAfterExecution: preset.keepWorkerAfterExecution === true,
			};
		}
	}
	return out;
}

function loadConfig(): DevFlowConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DevFlowConfig>;
			return {
				planner: isModelRef(raw.planner) ? raw.planner : DEFAULT_CONFIG.planner,
				worker: isModelRef(raw.worker) ? raw.worker : DEFAULT_CONFIG.worker,
				keepWorkerAfterExecution: raw.keepWorkerAfterExecution ?? false,
				presets: parsePresets(raw.presets),
			};
		}
	} catch {
		// fall through to defaults
	}
	return structuredClone(DEFAULT_CONFIG);
}

function saveConfig(config: DevFlowConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function refLabel(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

function shortName(ref: ModelRef): string {
	const parts = ref.id.split("/");
	return parts[parts.length - 1] ?? ref.id;
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Extract the plan text from the most recent assistant message that contains
 * a "Plan:" header. Falls back to the most recent non-empty assistant message.
 * Returns undefined when no assistant message is present.
 */
function extractPlanText(messages: AgentMessage[]): string | undefined {
	let lastAny: string | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!isAssistantMessage(m)) continue;
		const text = getTextContent(m).trim();
		if (!text) continue;
		if (lastAny === undefined) lastAny = text;
		if (/(^|\n)\s*(#+\s*)?Plan:/i.test(text)) return text;
	}
	return lastAny;
}

/**
 * Pull assistant messages (in order) from the current session branch so a
 * command handler can locate the plan without waiting for an agent_end event.
 */
function branchAssistantMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager
		.getBranch()
		.map((e) => (e.type === "message" ? e.message : undefined))
		.filter((m): m is AgentMessage => m !== undefined);
}

// ---------------------------------------------------------------------------
// Browser plan review — a self-contained annotatable plan viewer.
//
// devflow serves the plan from a tiny loopback HTTP server and opens it in the
// default browser: the user reads the rendered plan, selects text to attach
// quote+note annotations, then approves (annotations fold into the execution
// kickoff), requests changes (annotations go back to the planner), or
// dismisses. No dependencies beyond node builtins and no build step — the page
// lives in devflow-review.html next to this file.
// ---------------------------------------------------------------------------

interface PlanReviewDecision {
	approved: boolean;
	feedback?: string;
}

interface PlanReviewSession {
	url: string;
	waitForDecision: () => Promise<PlanReviewDecision>;
	/** Close the server without a decision (superseded, or the session ended). */
	cancel: (reason: string) => void;
}

/** Raised when a review is closed before the user decided. */
class ReviewStoppedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "ReviewStoppedError";
	}
}

const REVIEW_HOST = "127.0.0.1";
const REVIEW_PAGE_PATH = join(dirname(CONFIG_PATH), "extensions", "devflow-review.html");
const MAX_DECISION_BODY_BYTES = 256 * 1024;

let reviewPageTemplate: string | undefined;
let reviewPageMissing = false;

/** Read (and cache) the review page template; undefined when it is missing. */
function loadReviewPageTemplate(): string | undefined {
	if (reviewPageTemplate !== undefined) return reviewPageTemplate;
	if (reviewPageMissing) return undefined;
	try {
		if (!existsSync(REVIEW_PAGE_PATH)) {
			reviewPageMissing = true;
			return undefined;
		}
		reviewPageTemplate = readFileSync(REVIEW_PAGE_PATH, "utf8");
	} catch {
		reviewPageMissing = true;
		return undefined;
	}
	return reviewPageTemplate;
}

/**
 * Fill the page template with the plan and the request token. Both go in as
 * JSON with `<` escaped, so plan content can never break out of the script
 * tag; the replacement uses a function so `$` sequences in the plan are not
 * interpreted as replacement patterns.
 */
function buildPlanReviewPage(planText: string, token: string): string {
	const template = loadReviewPageTemplate();
	if (template === undefined) {
		throw new Error(`review page asset not found: ${REVIEW_PAGE_PATH}`);
	}
	const planJson = JSON.stringify(planText).replace(/</g, "\\u003c");
	const tokenJson = JSON.stringify(token).replace(/</g, "\\u003c");
	return template
		.replace("__PLAN_JSON__", () => planJson)
		.replace("__TOKEN_JSON__", () => tokenJson);
}

/** Serve the plan on a random loopback port and wait for the browser decision. */
function openPlanReviewSession(planText: string): Promise<PlanReviewSession> {
	const token = randomUUID();
	// Build the page up front so a missing asset fails before we bind a port.
	const page = buildPlanReviewPage(planText, token);

	return new Promise((resolve, reject) => {
		let resolveDecision: ((decision: PlanReviewDecision) => void) | undefined;
		let rejectDecision: ((err: Error) => void) | undefined;
		const decision = new Promise<PlanReviewDecision>((res, rej) => {
			resolveDecision = res;
			rejectDecision = rej;
		});
		// Never leave an unhandled rejection if nothing is awaiting yet.
		decision.catch(() => {});

		let settled = false;
		let closeWindow = (): void => {};

		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${REVIEW_HOST}`);
			const authorized = url.searchParams.get("token") === token;

			if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
				if (!authorized) {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Forbidden");
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(page);
				return;
			}

			if (req.method === "POST" && url.pathname === "/api/decision") {
				if (!authorized) {
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid token" }));
					return;
				}
				let body = "";
				req.on("data", (chunk) => {
					body += chunk.toString("utf8");
					if (body.length > MAX_DECISION_BODY_BYTES) req.destroy();
				});
				req.on("end", () => {
					let payload: { approved?: unknown; feedback?: unknown } = {};
					try {
						payload = JSON.parse(body || "{}") as { approved?: unknown; feedback?: unknown };
					} catch {
						// malformed body — treat as an empty decision
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					if (settled) return;
					settled = true;
					resolveDecision?.({
						approved: payload.approved === true,
						feedback:
							typeof payload.feedback === "string" && payload.feedback.trim()
								? payload.feedback.trim()
								: undefined,
					});
					closeServer();
				});
				return;
			}

			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
		});

		function closeServer(): void {
			server.close();
			// Node 18+/Bun: drop keep-alive sockets so the port frees immediately.
			(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
			const close = closeWindow;
			closeWindow = () => {};
			// Let the page show the banner / call window.close() before we kill the process.
			setTimeout(close, 600);
		}

		server.on("error", (err) => {
			if (settled) return;
			settled = true;
			closeServer();
			reject(err);
		});

		server.listen(0, REVIEW_HOST, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				if (!settled) {
					settled = true;
					closeServer();
					reject(new Error("plan review server got no address"));
				}
				return;
			}
			const url = `http://${REVIEW_HOST}:${address.port}/?token=${token}`;
			closeWindow = openReviewWindow(url);
			resolve({
				url,
				waitForDecision: () => decision,
				cancel: (reason: string) => {
					if (settled) return;
					settled = true;
					closeServer();
					rejectDecision?.(new ReviewStoppedError(reason));
				},
			});
		});
	});
}

function findBrowserBin(): string | undefined {
	const local = process.env.LOCALAPPDATA ?? "";
	const candidates =
		process.platform === "win32"
			? [
					join(local, "Google", "Chrome", "Application", "chrome.exe"),
					"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
					"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
					"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
				]
			: process.platform === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
					]
				: ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
	return candidates.find((p) => existsSync(p));
}

/** Open a URL in the OS default browser (fallback when Chrome/Edge isn't found). */
function openInBrowser(url: string): void {
	const command =
		process.platform === "win32"
			? `start "" "${url}"`
			: process.platform === "darwin"
				? `open "${url}"`
				: `xdg-open "${url}"`;
	exec(command, (error) => {
		if (error) console.error(`devflow: could not open the browser: ${error.message}`);
	});
}

/** Dedicated Chrome/Edge app window so we can close it after a decision. */
function openReviewWindow(url: string): () => void {
	const bin = findBrowserBin();
	if (!bin) {
		openInBrowser(url);
		return () => {};
	}
	const profile = join(tmpdir(), "devflow-review-" + randomUUID());
	try {
		mkdirSync(profile, { recursive: true });
	} catch {
		openInBrowser(url);
		return () => {};
	}
	const child = spawn(
		bin,
		["--app=" + url, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check"],
		{ stdio: "ignore" },
	);
	child.on("error", () => openInBrowser(url));
	let closed = false;
	return () => {
		if (closed) return;
		closed = true;
		if (child.pid && process.platform === "win32") {
			exec("taskkill /PID " + child.pid + " /T /F", () => {});
		} else {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		}
		// ponytail: leftover profile dirs in tmp if chrome still has files open
	};
}

export default function devFlowExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	let phase: Phase = "idle";
	let toolsBeforePlanning: string[] | undefined;
	let modelBeforePlanning: ModelRef | undefined;
	// True while devflow itself is switching models, so model_select events
	// triggered by applyModel() are not treated as user overrides.
	let devflowSwitching = false;

	function persistConfig(): void {
		saveConfig(config);
		// Let other extensions (e.g. reasoning-panel footer) react to role changes.
		pi.events.emit("devflow:config", config);
	}

	// ---------- helpers ----------

	async function applyModel(ref: ModelRef, ctx: ExtensionContext): Promise<boolean> {
		const model = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!model) {
			ctx.ui.notify(`devflow: model not found: ${refLabel(ref)}. Run /df to reconfigure.`, "error");
			return false;
		}
		devflowSwitching = true;
		let ok = false;
		try {
			ok = await pi.setModel(model);
		} finally {
			devflowSwitching = false;
		}
		if (!ok) {
			ctx.ui.notify(`devflow: no API key available for ${refLabel(ref)}`, "error");
			return false;
		}
		// Only assert the role's thinking level if it differs from the user's
		// current setting — a manual /thinking change made after phase entry
		// should not be clobbered on subsequent applies.
		if (ref.thinking && pi.getThinkingLevel() !== ref.thinking) {
			pi.setThinkingLevel(ref.thinking);
		}
		return true;
	}

	function enablePlanningTools(): void {
		if (toolsBeforePlanning === undefined) toolsBeforePlanning = pi.getActiveTools();
		const filtered = toolsBeforePlanning.filter((name) => !PLANNING_DISABLED_TOOLS.has(name));
		pi.setActiveTools([...new Set([...filtered, ...PLANNING_EXTRA_TOOLS])]);
	}

	function restoreTools(): void {
		if (toolsBeforePlanning !== undefined) {
			pi.setActiveTools(toolsBeforePlanning);
			toolsBeforePlanning = undefined;
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (phase === "planning") {
			ctx.ui.setStatus("devflow", ctx.ui.theme.fg("warning", `📝 plan → ${shortName(config.planner)}`));
		} else if (phase === "executing") {
			ctx.ui.setStatus("devflow", ctx.ui.theme.fg("accent", `⚙ exec → ${shortName(config.worker)}`));
		} else if (phase === "reviewing") {
			ctx.ui.setStatus("devflow", ctx.ui.theme.fg("warning", `🔍 review → ${shortName(config.planner)}`));
		} else {
			ctx.ui.setStatus("devflow", undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry("devflow", {
			phase,
			toolsBeforePlanning,
			modelBeforePlanning,
		});
	}

	async function pickModel(ctx: ExtensionContext, title: string, current: ModelRef): Promise<ModelRef | undefined> {
		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			ctx.ui.notify("devflow: no models available", "error");
			return undefined;
		}
		const labels = models.map((m) => {
			const label = `${m.provider}/${m.id}`;
			return label === refLabel(current) ? `${label}  (current)` : label;
		});
		const choice = await ctx.ui.select(title, labels);
		if (!choice) return undefined;
		const idx = labels.indexOf(choice);
		const model = models[idx];
		if (!model) return undefined;
		const thinking = await ctx.ui.select(
			`Thinking level for ${model.id}:`,
			["keep current", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
		);
		return {
			provider: model.provider,
			id: model.id,
			thinking: thinking && thinking !== "keep current" ? (thinking as ThinkingLevel) : current.thinking,
		};
	}

	// ---------- presets ----------

	function presetNames(): string[] {
		return Object.keys(config.presets ?? {});
	}

	function savePreset(name: string, ctx: ExtensionContext): void {
		if (!name || name === "save" || name === "delete" || name === "list" || name === "rename") {
			ctx.ui.notify(`Invalid preset name: "${name}"`, "error");
			return;
		}
		config.presets ??= {};
		config.presets[name] = {
			planner: { ...config.planner },
			worker: { ...config.worker },
			keepWorkerAfterExecution: config.keepWorkerAfterExecution === true,
		};
		persistConfig();
		ctx.ui.notify(
			`Preset "${name}" saved — planner: ${refLabel(config.planner)}, worker: ${refLabel(config.worker)}`,
			"info",
		);
	}

	function deletePreset(name: string, ctx: ExtensionContext): void {
		if (!config.presets?.[name]) {
			ctx.ui.notify(`No preset named "${name}"`, "error");
			return;
		}
		delete config.presets[name];
		persistConfig();
		ctx.ui.notify(`Preset "${name}" deleted`, "info");
	}

	function renamePreset(oldName: string, newName: string, ctx: ExtensionContext): void {
		if (!config.presets?.[oldName]) {
			ctx.ui.notify(`No preset named "${oldName}"`, "error");
			return;
		}
		if (
			!newName ||
			newName === "save" ||
			newName === "delete" ||
			newName === "list" ||
			newName === "rename" ||
			config.presets[newName]
		) {
			ctx.ui.notify(`Invalid or existing preset name: "${newName}"`, "error");
			return;
		}
		config.presets[newName] = config.presets[oldName];
		delete config.presets[oldName];
		persistConfig();
		ctx.ui.notify(`Preset "${oldName}" renamed to "${newName}"`, "info");
	}

	async function applyPreset(name: string, ctx: ExtensionContext): Promise<void> {
		const preset = config.presets?.[name];
		if (!preset) {
			ctx.ui.notify(`No preset named "${name}". Available: ${presetNames().join(", ") || "(none)"}`, "error");
			return;
		}
		config.planner = { ...preset.planner };
		config.worker = { ...preset.worker };
		config.keepWorkerAfterExecution = preset.keepWorkerAfterExecution === true;
		persistConfig();
		updateStatus(ctx);
		ctx.ui.notify(
			`Preset "${name}" applied — planner: ${refLabel(config.planner)}, worker: ${refLabel(config.worker)}`,
			"info",
		);
		// Apply the new role model right away when a phase is active.
		if (phase === "planning" || phase === "reviewing") await applyModel(config.planner, ctx);
		else if (phase === "executing") await applyModel(config.worker, ctx);
	}

	async function enterPlanning(ctx: ExtensionContext): Promise<void> {
		if (!ctx.model) {
			ctx.ui.notify("devflow: no model selected — pick one first.", "error");
			return;
		}
		modelBeforePlanning = { provider: ctx.model.provider, id: ctx.model.id, thinking: ctx.thinkingLevel };
		if (!(await applyModel(config.planner, ctx))) return;
		phase = "planning";
		enablePlanningTools();
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(
			`Planning phase: ${refLabel(config.planner)} (edit/write disabled). Describe what you want to build.`,
			"info",
		);
	}

	async function exitPlanning(ctx: ExtensionContext, restoreModel: boolean): Promise<void> {
		phase = "idle";
		restoreTools();
		if (restoreModel && modelBeforePlanning) {
			// Respect a thinking-level change the user made during planning.
			const restore = { ...modelBeforePlanning, thinking: ctx.thinkingLevel };
			await applyModel(restore, ctx);
		}
		modelBeforePlanning = undefined;
		updateStatus(ctx);
		persistState();
	}

	async function startExecution(ctx: ExtensionContext, reviewFeedback?: string): Promise<void> {
		restoreTools();
		if (!(await applyModel(config.worker, ctx))) return;
		phase = "executing";
		// Keep modelBeforePlanning so the prime model can be restored when the
		// execution run settles (unless keepWorkerAfterExecution is set).
		updateStatus(ctx);
		persistState();
		pi.sendMessage(
			{
				customType: "devflow-execute",
				content: `[DEVFLOW: EXECUTION PHASE]
The plan above was written by the planning model. You are the worker model with full tool access.
${reviewFeedback ? `\nPlan-review annotations from the user — fold them into the execution:\n\n${reviewFeedback}\n` : ""}
Execute the plan step by step:
- Follow the numbered steps in order.
- Verify each change (build/tests/reads) before moving on.
- If a step is impossible or wrong, say so and adapt minimally — do not redesign the plan.
- When all steps are done, summarize what was changed.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	/**
	 * After the execution run settles, switch back to the planner with
	 * read-only tools and have it evaluate the worker's output against the plan.
	 */
	async function startReview(ctx: ExtensionContext): Promise<void> {
		enablePlanningTools(); // read-only during review; restored at finish
		if (!(await applyModel(config.planner, ctx))) {
			await finishReview(ctx, "could not switch to the planner for review");
			return;
		}
		phase = "reviewing";
		updateStatus(ctx);
		persistState();
		pi.sendMessage(
			{
				customType: "devflow-review-context",
				content: `[DEVFLOW: REVIEW PHASE]
The worker model just executed the plan above. You are now the planning model again, reviewing its work. edit/write are disabled; shell is restricted to read-only commands.

Evaluate the work:
- Verify every planned step actually happened (read/grep the touched files).
- Check correctness and completeness against the plan's intent.
- Flag anything missed, broken, or risky.

End with a verdict line: "Verdict: PASS" when all steps are done correctly, or "Verdict: ISSUES" followed by a numbered list of problems.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	/** Review settled (or could not start) — restore the prime model and go idle. */
	async function finishReview(ctx: ExtensionContext, note?: string): Promise<void> {
		phase = "idle";
		restoreTools();
		updateStatus(ctx);
		if (note) ctx.ui.notify(`devflow: ${note}`, "warning");

		if (modelBeforePlanning && !config.keepWorkerAfterExecution) {
			const restore = { ...modelBeforePlanning, thinking: ctx.thinkingLevel };
			if (await applyModel(restore, ctx)) {
				ctx.ui.notify(`DevFlow review finished. Restored prime model: ${refLabel(restore)}`, "info");
			} else {
				ctx.ui.notify("DevFlow review finished (could not restore prime model).", "warning");
			}
		} else {
			// keepWorkerAfterExecution, or no prime recorded (new-session handover):
			// re-apply the worker so it ends active, as before the review existed.
			if (await applyModel(config.worker, ctx)) {
				ctx.ui.notify("DevFlow review finished. Worker model stays active.", "info");
			} else {
				ctx.ui.notify("DevFlow review finished (planner stays active).", "warning");
			}
		}
		modelBeforePlanning = undefined;
		persistState();
	}

	/**
	 * Hand the plan off to the worker model in a brand-new session whose only
	 * context is the plan plus the execution instructions.
	 *
	 * The new session's extension instance starts fresh (phase "idle"), so we
	 * record a "pending execute" custom entry in `setup` and let the new
	 * instance's `before_agent_start` handler pick it up, switch to the worker
	 * model, and enter the executing phase before the first turn runs.
	 *
	 * `ctx` must be a command context (it has `newSession`); event-handler
	 * contexts do not.
	 */
	async function executeInNewSession(ctx: ExtensionCommandContext, planText: string): Promise<void> {
		const parentSession = ctx.sessionManager.getSessionFile();
		const kickoff = `[DEVFLOW: EXECUTION HANDOVER — NEW SESSION]
The plan below was produced by the planning model in a previous session. You are the worker model with full tool access. This session contains only the plan — execute it from scratch.

${planText}

Execute the plan step by step:
- Follow the numbered steps in order.
- Verify each change (build/tests/reads) before moving on.
- If a step is impossible or wrong, say so and adapt minimally — do not redesign the plan.
- When all steps are done, summarize what was changed.`;

		const result = await ctx.newSession({
			parentSession,
			setup: async (sm) => {
				// Signal the new extension instance to enter the executing phase
				// and apply the worker model before its first agent turn. The
				// new instance's session_start has already fired (empty), so
				// before_agent_start is what reads this.
				sm.appendCustomEntry("devflow", { phase: "executing", pendingExecute: true });
			},
			withSession: async (replacementCtx) => {
				// Triggering the turn fires before_agent_start in the new
				// instance, which applies the worker model, then the worker
				// executes the plan.
				await replacementCtx.sendUserMessage(kickoff);
			},
		});

		if (result.cancelled) {
			ctx.ui.notify("devflow: new-session handover was cancelled.", "info");
		}
	}

	/**
	 * Locate the plan in the current branch and prompt the user to hand it off
	 * to the worker model — either in this session or in a fresh session that
	 * contains only the plan. Used by both the /confirm command and the
	 * agent_end auto-prompt.
	 */
	async function confirmHandover(ctx: ExtensionCommandContext): Promise<void> {
		if (phase !== "planning") {
			ctx.ui.notify(
				"devflow: not in planning phase. Run /plan first and have the planner produce a Plan:.",
				"warning",
			);
			return;
		}

		const planText = extractPlanText(branchAssistantMessages(ctx));
		if (!planText) {
			ctx.ui.notify("devflow: no plan found in the conversation yet.", "warning");
			return;
		}

		const choice = await ctx.ui.select(
			`DevFlow — confirm plan handover to ${refLabel(config.worker)}?`,
			[
				"Review in browser (annotatable plan)",
				"Start in a new session (only the plan in context)",
				"Continue in this session (full context)",
				"Refine the plan",
				"Cancel",
			],
		);

		if (choice === "Review in browser (annotatable plan)") {
			await openBrowserPlanReview(ctx, planText);
		} else if (choice === "Start in a new session (only the plan in context)") {
			await executeInNewSession(ctx, planText);
		} else if (choice === "Continue in this session (full context)") {
			await startExecution(ctx);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
		// "Cancel" -> do nothing
	}

	// ---------- browser plan review ----------

	/** Review awaiting a browser decision; at most one at a time. */
	let pendingReview: { session: PlanReviewSession; ctx: ExtensionContext } | undefined;

	/** Notify without throwing when the ctx went stale (session replaced). */
	function safeNotify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		try {
			ctx.ui.notify(message, type);
		} catch {
			// stale ctx — nothing left to do.
		}
	}

	function safeUpdateStatus(ctx: ExtensionContext): void {
		try {
			updateStatus(ctx);
		} catch {
			// stale ctx — nothing left to do.
		}
	}

	async function applyReviewDecision(ctx: ExtensionContext, decision: PlanReviewDecision): Promise<void> {
		safeUpdateStatus(ctx); // drop the "awaiting browser review" status
		if (phase !== "planning") {
			// The user left the planning phase while reviewing (e.g. /plan toggle).
			safeNotify(ctx, "devflow: plan review decision arrived after planning ended — ignoring it.", "info");
			return;
		}
		if (decision.approved) {
			await startExecution(ctx, decision.feedback);
		} else if (decision.feedback) {
			pi.sendUserMessage(
				`[DEVFLOW: PLAN REVIEW FEEDBACK]\nThe user reviewed your plan in the browser and requested changes:\n\n${decision.feedback}\n\nRevise the plan accordingly and output an updated numbered plan under a "Plan:" header.`,
				{ deliverAs: "followUp" },
			);
		} else {
			safeNotify(ctx, "devflow: plan review dismissed without a decision — still in planning phase.", "info");
		}
	}

	/**
	 * Serve the plan on a loopback port and open it in the default browser as
	 * an annotatable document. Returns false when the server or page asset is
	 * unavailable, so the caller can fall back to the terminal prompt.
	 */
	async function openBrowserPlanReview(ctx: ExtensionContext, planText: string): Promise<boolean> {
		if (!ctx.hasUI) return false;

		// Supersede a review that is still open (e.g. the plan was revised).
		pendingReview?.session.cancel("superseded by a newer plan review");
		pendingReview = undefined;

		let session: PlanReviewSession;
		try {
			session = await openPlanReviewSession(planText);
		} catch (err) {
			ctx.ui.notify(
				`devflow: browser plan review unavailable (${err instanceof Error ? err.message : String(err)}) — using the terminal prompt instead.`,
				"warning",
			);
			return false;
		}

		pendingReview = { session, ctx };
		ctx.ui.setStatus(
			"devflow",
			ctx.ui.theme.fg("warning", `📝 plan → ${shortName(config.planner)} · awaiting browser review`),
		);
		ctx.ui.notify("Plan review opened in a separate browser window — approve, annotate, or request changes.", "info");

		void session
			.waitForDecision()
			.then((decision) => {
				if (pendingReview?.session === session) pendingReview = undefined;
				return applyReviewDecision(ctx, decision);
			})
			.catch((err: unknown) => {
				if (pendingReview?.session === session) pendingReview = undefined;
				safeUpdateStatus(ctx);
				if (err instanceof ReviewStoppedError) {
					safeNotify(ctx, "devflow: plan review closed without a decision — still in planning phase.", "info");
					return;
				}
				safeNotify(ctx, `devflow: plan review failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			});

		return true;
	}

	pi.on("session_shutdown", () => {
		pendingReview?.session.cancel("session ended");
		pendingReview = undefined;
	});

	// ---------- commands & shortcuts ----------

	pi.registerCommand("df", {
		description: "Configure devflow planning/worker models and presets",
		handler: async (_args, ctx) => {
			const action = await ctx.ui.select(
				`DevFlow — planner: ${refLabel(config.planner)} | worker: ${refLabel(config.worker)}`,
				[
					"Set planning model",
					"Set worker model",
					"Switch preset",
					"Save current combo as preset",
					"Delete a preset",
					"Rename a preset",
					"Toggle keep-worker-after-execution",
					"Reset to defaults",
					"Show config",
				],
			);
			if (action === "Set planning model") {
				const picked = await pickModel(ctx, "Pick the PLANNING model:", config.planner);
				if (picked) {
					config.planner = picked;
					persistConfig();
					ctx.ui.notify(`Planning model: ${refLabel(picked)}`, "info");
				}
			} else if (action === "Set worker model") {
				const picked = await pickModel(ctx, "Pick the WORKER model:", config.worker);
				if (picked) {
					config.worker = picked;
					persistConfig();
					ctx.ui.notify(`Worker model: ${refLabel(picked)}`, "info");
				}
			} else if (action === "Switch preset") {
				const names = presetNames();
				if (names.length === 0) {
					ctx.ui.notify("No presets yet — save one first with /preset save <name>.", "info");
				} else {
					const name = await ctx.ui.select("Switch to preset:", names);
					if (name) await applyPreset(name, ctx);
				}
			} else if (action === "Save current combo as preset") {
				const name = await ctx.ui.input("Preset name:", "e.g. fast-cheap");
				if (name?.trim()) savePreset(name.trim(), ctx);
			} else if (action === "Delete a preset") {
				const names = presetNames();
				if (names.length === 0) {
					ctx.ui.notify("No presets to delete.", "info");
				} else {
					const name = await ctx.ui.select("Delete preset:", names);
					if (name) deletePreset(name, ctx);
				}
			} else if (action === "Rename a preset") {
				const names = presetNames();
				if (names.length === 0) {
					ctx.ui.notify("No presets to rename.", "info");
				} else {
					const oldName = await ctx.ui.select("Rename preset:", names);
					if (oldName) {
						const newName = await ctx.ui.input(`New name for "${oldName}":`, oldName);
						if (newName?.trim()) renamePreset(oldName, newName.trim(), ctx);
					}
				}
			} else if (action === "Reset to defaults") {
				const keptPresets = config.presets;
				config = structuredClone(DEFAULT_CONFIG);
				// Reset the models, but keep the user's saved presets.
				config.presets = keptPresets ?? structuredClone(DEFAULT_CONFIG.presets);
				persistConfig();
				ctx.ui.notify("devflow config reset to defaults (presets kept)", "info");
			} else if (action === "Toggle keep-worker-after-execution") {
				config.keepWorkerAfterExecution = !config.keepWorkerAfterExecution;
				persistConfig();
				ctx.ui.notify(
					config.keepWorkerAfterExecution
						? "Keep worker model active after the review finishes"
						: "Restore prime model after the review finishes",
					"info",
				);
			} else if (action === "Show config") {
				ctx.ui.notify(
					`planner: ${refLabel(config.planner)} (thinking: ${config.planner.thinking ?? "default"})\n` +
						`worker:  ${refLabel(config.worker)} (thinking: ${config.worker.thinking ?? "default"})\n` +
						`keepWorkerAfterExecution: ${config.keepWorkerAfterExecution === true}\n` +
						`presets: ${presetNames().join(", ") || "(none)"}\n` +
						`config:  ${CONFIG_PATH}`,
					"info",
				);
			}
		},
	});

	async function togglePlanning(ctx: ExtensionContext): Promise<void> {
		if (phase === "planning") {
			await exitPlanning(ctx, true);
			ctx.ui.notify("Planning phase cancelled. Model and tools restored.", "info");
			return;
		}
		if (phase !== "idle") {
			ctx.ui.notify(`devflow: busy in the ${phase} phase — wait for it to finish or abort first.`, "warning");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent is mid-run — wait for it to finish or abort before entering planning.", "warning");
			return;
		}
		await enterPlanning(ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle devflow planning phase (plan with planner model)",
		handler: async (_args, ctx) => {
			await togglePlanning(ctx);
		},
	});

	pi.registerCommand("confirm", {
		description: "Confirm the devflow plan and hand off to the worker model",
		handler: async (_args, ctx) => {
			await confirmHandover(ctx);
		},
	});

	pi.registerCommand("preset", {
		description: "DevFlow model-combo presets: /preset <name> | save <name> | delete <name> | rename <old> <new> | list",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const names = presetNames();
			const items: AutocompleteItem[] = [];
			const spaceAt = prefix.indexOf(" ");
			if (spaceAt === -1) {
				// First token: preset names plus subcommands (trailing space keeps typing).
				for (const name of names) {
					if (name.startsWith(prefix)) {
						items.push({ value: name, label: name, description: "switch to this preset" });
					}
				}
				for (const sub of ["save", "delete", "rename", "list"]) {
					if (sub.startsWith(prefix)) {
						items.push({
							value: `${sub} `,
							label: sub,
							description:
								sub === "save"
									? "save the current combo as a preset"
									: sub === "delete"
										? "delete a preset"
										: sub === "rename"
											? "rename a preset"
										: "list all presets",
						});
					}
				}
			} else {
				const head = prefix.slice(0, spaceAt);
				const rest = prefix.slice(spaceAt + 1);
				if (head === "save" || head === "delete" || head === "rename") {
					for (const name of names) {
						if (name.startsWith(rest)) items.push({ value: `${head} ${name}`, label: name });
					}
				}
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (!sub || sub === "list") {
				const names = presetNames();
				if (names.length === 0) {
					ctx.ui.notify("No presets yet — create one with /preset save <name> or via /df.", "info");
					return;
				}
				const lines = names.map((name) => {
					const preset = config.presets?.[name];
					if (!preset) return name;
					const active =
						refLabel(preset.planner) === refLabel(config.planner) &&
						refLabel(preset.worker) === refLabel(config.worker);
					const suffix = preset.keepWorkerAfterExecution ? " · keep worker" : "";
					return `${name}: plan ${refLabel(preset.planner)} · work ${refLabel(preset.worker)}${suffix}${active ? "  ← active" : ""}`;
				});
				ctx.ui.notify(`DevFlow presets:\n${lines.join("\n")}`, "info");
				return;
			}
			if (sub.startsWith("save ")) {
				savePreset(sub.slice(5).trim(), ctx);
				return;
			}
			if (sub.startsWith("delete ")) {
				deletePreset(sub.slice(7).trim(), ctx);
				return;
			}
			if (sub.startsWith("rename ")) {
				const [oldName, ...rest] = sub.slice(7).trim().split(/\s+/);
				renamePreset(oldName, rest.join(" "), ctx);
				return;
			}
			await applyPreset(sub, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle devflow planning phase",
		handler: async (ctx) => {
			await togglePlanning(ctx);
		},
	});

	// ---------- guards ----------

	// Block mutations while planning OR reviewing (the planner is read-only in both).
	pi.on("tool_call", async (event) => {
		if (phase !== "planning" && phase !== "reviewing") return;

		if (PLANNING_DISABLED_TOOLS.has(event.toolName)) {
			return { block: true, reason: "devflow planning phase: file mutation tools are disabled." };
		}

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = String((event.input as { command?: string }).command ?? "");
			if (DESTRUCTIVE_PATTERNS.some((re) => re.test(command))) {
				return {
					block: true,
					reason: `devflow planning phase: destructive command blocked.\nCommand: ${command}`,
				};
			}
		}
	});

	// ---------- context shaping ----------

	pi.on("before_agent_start", async (_event, ctx) => {
		if (phase === "planning") {
			return {
				message: {
					customType: "devflow-planning-context",
					content: `[DEVFLOW: PLANNING PHASE]
You are the planning model. Your job is to research the codebase and produce an implementation plan for the worker model to execute. Do NOT make any changes.

Rules:
- edit/write tools are disabled; shell is restricted to read-only commands.
- Explore the code as needed (read, grep, find, ls).
- Ask clarifying questions if requirements are ambiguous.

Output a detailed numbered plan under a "Plan:" header:

Plan:
1. First step (file paths, exact changes)
2. Second step
...

Each step must be concrete enough for a less capable model to execute without re-doing the research: name files, functions, and the exact intent of each change.`,
					display: false,
				},
			};
		}

		// New-session handover: the plan was confirmed in another session and
		// this fresh session was created with a "pending execute" marker. Enter
		// the executing phase and apply the worker model before the first turn.
		if (phase === "idle") {
			const entries = ctx.sessionManager.getEntries();
			const marker = entries
				.filter((e): e is CustomEntry => e.type === "custom" && (e as { customType?: string }).customType === "devflow")
				.pop();
			const data = marker?.data as { pendingExecute?: boolean } | undefined;
			if (data?.pendingExecute) {
				phase = "executing";
				updateStatus(ctx);
				persistState();
				await applyModel(config.worker, ctx);
			}
		}
	});

	// Drop stale phase instructions from context once the phase is over
	pi.on("context", async (event) => {
		const stale: string[] = [];
		if (phase !== "planning") stale.push("devflow-planning-context");
		if (phase !== "reviewing") stale.push("devflow-review-context");
		if (stale.length === 0) return;
		return {
			messages: event.messages.filter(
				(m) => !stale.includes((m as AgentMessage & { customType?: string }).customType ?? ""),
			),
		};
	});

	// ---------- phase transitions ----------

	pi.on("agent_end", async (event, ctx) => {
		if (phase !== "planning" || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;
		const text = getTextContent(lastAssistant);
		if (!/(^|\n)\s*(#+\s*)?Plan:/i.test(text)) return; // no plan produced yet, keep planning

		// A browser review is already open — wait for its decision instead of
		// stacking another one.
		if (pendingReview) return;

		// Present the plan as an annotatable document in the browser; fall back
		// to the terminal prompt when the review server is unavailable.
		const planText = extractPlanText(branchAssistantMessages(ctx)) ?? text;
		if (await openBrowserPlanReview(ctx, planText)) return;

		const choice = await ctx.ui.select(
			`DevFlow — plan ready. Execute with ${refLabel(config.worker)}? (run /confirm to also start in a new session)`,
			[
				"Execute plan with worker model",
				"Refine the plan",
				"Stay in planning phase",
				"Abandon (restore previous model)",
			],
		);

		if (choice === "Execute plan with worker model") {
			await startExecution(ctx);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		} else if (choice === "Abandon (restore previous model)") {
			await exitPlanning(ctx, true);
			ctx.ui.notify("Planning abandoned. Model and tools restored.", "info");
		}
		// "Stay in planning phase" -> do nothing
	});

	// Execution settled → hand the work to the planner for review.
	// Review settled (or review could not start) → restore the prime model.
	pi.on("agent_settled", async (_event, ctx) => {
		if (phase === "executing") {
			ctx.ui.notify("DevFlow execution run finished — planner is reviewing the work.", "info");
			await startReview(ctx);
			return;
		}
		if (phase === "reviewing") {
			await finishReview(ctx);
		}
	});

	// Track user-driven model changes during planning so Abandon restores the
	// model the user actually ended up on, not the one from before /plan.
	pi.on("model_select", async (event, ctx) => {
		if (devflowSwitching) return;
		if (phase !== "planning") return;
		if (event.source !== "set" && event.source !== "cycle") return;

		modelBeforePlanning = {
			provider: event.model.provider,
			id: event.model.id,
			thinking: ctx.thinkingLevel,
		};
		persistState();
	});

	// ---------- session restore ----------

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();

		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "devflow")
			.pop() as { data?: { phase?: Phase; toolsBeforePlanning?: string[]; modelBeforePlanning?: ModelRef } } | undefined;

		if (stateEntry?.data) {
			phase = stateEntry.data.phase ?? "idle";
			toolsBeforePlanning = stateEntry.data.toolsBeforePlanning;
			modelBeforePlanning = stateEntry.data.modelBeforePlanning;
		}

		// Re-apply the phase's role model on resume, unless pi already restored
		// (or the user overrode with --model) that same model.
		const target =
			phase === "planning" || phase === "reviewing"
				? config.planner
				: phase === "executing"
					? config.worker
					: undefined;
		if (target) {
			if (phase === "planning" || phase === "reviewing") enablePlanningTools();
			const current = ctx.model;
			const alreadyOnTarget =
				current && current.provider === target.provider && current.id === target.id;
			if (!alreadyOnTarget) await applyModel(target, ctx);
		}
		updateStatus(ctx);
	});
}
