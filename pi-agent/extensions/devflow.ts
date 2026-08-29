/**
 * DevFlow Extension — plan with a strong model, execute with a fast/cheap one.
 *
 * Workflow:
 *   /devflow          - configure the planning model and the worker model
 *   /plan (Ctrl+Alt+D) - toggle planning phase:
 *       - switches to the planning model (default: Claude Fable 5)
 *       - disables edit/write tools, blocks destructive shell commands
 *       - the model produces a numbered plan under a "Plan:" header
 *   After planning, choose "Execute" to:
 *       - switch to the worker model (default: Kimi K3)
 *       - restore full tool access
 *       - kick off execution of the plan (plan stays in context)
 *
 * Config persists in ~/.pi/agent/devflow.json.
 * Phase state persists in the session (survives /resume).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Phase = "idle" | "planning" | "executing";

interface ModelRef {
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
}

interface DevFlowConfig {
	planner: ModelRef;
	worker: ModelRef;
	keepWorkerAfterExecution?: boolean;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "devflow.json");
const PLANNOTATOR_CONFIG_PATH = join(homedir(), ".pi", "agent", "plannotator.json");

interface PlannotatorPhaseProfile {
	model?: { provider: string; id: string } | null;
	thinking?: ThinkingLevel | null;
	[key: string]: unknown;
}

interface PlannotatorConfig {
	phases?: {
		planning?: PlannotatorPhaseProfile;
		executing?: PlannotatorPhaseProfile;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/**
 * Mirror devflow's planner/worker models into plannotator.json so both
 * extensions plan and execute with the same models. devflow.json stays the
 * single source of truth. Plannotator reads its config on session_start, so
 * changes apply to plannotator on the next session or /reload.
 *
 * Preserves all unrelated keys in an existing plannotator.json; an invalid
 * file is backed up to plannotator.json.bak instead of being clobbered.
 * Never throws — sync problems must not break devflow itself.
 */
function syncPlannotatorConfig(config: DevFlowConfig): boolean {
	try {
		let existing: PlannotatorConfig = {};
		if (existsSync(PLANNOTATOR_CONFIG_PATH)) {
			const raw = readFileSync(PLANNOTATOR_CONFIG_PATH, "utf8");
			try {
				const parsed: unknown = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					existing = parsed as PlannotatorConfig;
				}
			} catch {
				writeFileSync(`${PLANNOTATOR_CONFIG_PATH}.bak`, raw, "utf8");
				existing = {};
			}
		}

		const phases = existing.phases ?? {};
		phases.planning = {
			...phases.planning,
			model: { provider: config.planner.provider, id: config.planner.id },
			thinking: config.planner.thinking ?? null,
		};
		phases.executing = {
			...phases.executing,
			model: { provider: config.worker.provider, id: config.worker.id },
			thinking: config.worker.thinking ?? null,
		};
		existing.phases = phases;

		mkdirSync(dirname(PLANNOTATOR_CONFIG_PATH), { recursive: true });
		writeFileSync(PLANNOTATOR_CONFIG_PATH, JSON.stringify(existing, null, 2), "utf8");
		return true;
	} catch {
		return false;
	}
}

const DEFAULT_CONFIG: DevFlowConfig = {
	planner: { provider: "anthropic", id: "claude-fable-5", thinking: "high" },
	worker: { provider: "fireworks", id: "accounts/fireworks/models/kimi-k3", thinking: "high" },
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

function loadConfig(): DevFlowConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DevFlowConfig>;
			return {
				planner: raw.planner ?? DEFAULT_CONFIG.planner,
				worker: raw.worker ?? DEFAULT_CONFIG.worker,
				keepWorkerAfterExecution: raw.keepWorkerAfterExecution ?? false,
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

export default function devFlowExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	// Propagate a hand-edited devflow.json on startup; plannotator picks it
	// up on its next session_start / /reload.
	syncPlannotatorConfig(config);
	let phase: Phase = "idle";
	let toolsBeforePlanning: string[] | undefined;
	let modelBeforePlanning: ModelRef | undefined;
	// True while devflow itself is switching models, so model_select events
	// triggered by applyModel() are not treated as user overrides.
	let devflowSwitching = false;

	function persistConfig(ctx?: ExtensionContext): void {
		saveConfig(config);
		const synced = syncPlannotatorConfig(config);
		if (ctx) {
			ctx.ui.notify(
				synced
					? "plannotator.json synced (applies to plannotator on next session or /reload)"
					: "devflow: failed to sync plannotator.json — update it manually",
				synced ? "info" : "warning",
			);
		}
		// Let other extensions (e.g. reasoning-panel footer) react to role changes.
		pi.events.emit("devflow:config", config);
	}

	// ---------- helpers ----------

	async function applyModel(ref: ModelRef, ctx: ExtensionContext): Promise<boolean> {
		const model = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!model) {
			ctx.ui.notify(`devflow: model not found: ${refLabel(ref)}. Run /devflow to reconfigure.`, "error");
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

	async function enterPlanning(ctx: ExtensionContext): Promise<void> {
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

	async function startExecution(ctx: ExtensionContext): Promise<void> {
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

	// ---------- commands & shortcuts ----------

	pi.registerCommand("devflow", {
		description: "Configure devflow planning/worker models",
		handler: async (_args, ctx) => {
			const action = await ctx.ui.select(
				`DevFlow — planner: ${refLabel(config.planner)} | worker: ${refLabel(config.worker)}`,
				[
					"Set planning model",
					"Set worker model",
					"Toggle keep-worker-after-execution",
					"Reset to defaults",
					"Show config",
				],
			);
			if (action === "Set planning model") {
				const picked = await pickModel(ctx, "Pick the PLANNING model:", config.planner);
				if (picked) {
					config.planner = picked;
					persistConfig(ctx);
					ctx.ui.notify(`Planning model: ${refLabel(picked)}`, "info");
				}
			} else if (action === "Set worker model") {
				const picked = await pickModel(ctx, "Pick the WORKER model:", config.worker);
				if (picked) {
					config.worker = picked;
					persistConfig(ctx);
					ctx.ui.notify(`Worker model: ${refLabel(picked)}`, "info");
				}
			} else if (action === "Reset to defaults") {
				config = structuredClone(DEFAULT_CONFIG);
				persistConfig(ctx);
				ctx.ui.notify("devflow config reset to defaults", "info");
			} else if (action === "Toggle keep-worker-after-execution") {
				config.keepWorkerAfterExecution = !config.keepWorkerAfterExecution;
				persistConfig(ctx);
				ctx.ui.notify(
					config.keepWorkerAfterExecution
						? "Keep worker model active after execution finishes"
						: "Restore prime model after execution finishes",
					"info",
				);
			} else if (action === "Show config") {
				ctx.ui.notify(
					`planner: ${refLabel(config.planner)} (thinking: ${config.planner.thinking ?? "default"})\n` +
						`worker:  ${refLabel(config.worker)} (thinking: ${config.worker.thinking ?? "default"})\n` +
						`keepWorkerAfterExecution: ${config.keepWorkerAfterExecution === true}\n` +
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

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle devflow planning phase",
		handler: async (ctx) => {
			await togglePlanning(ctx);
		},
	});

	// ---------- guards ----------

	pi.on("tool_call", async (event) => {
		if (phase !== "planning") return;

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

	pi.on("before_agent_start", async () => {
		if (phase !== "planning") return;
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
	});

	// Drop stale planning instructions from context once out of planning
	pi.on("context", async (event) => {
		if (phase === "planning") return;
		return {
			messages: event.messages.filter(
				(m) => (m as AgentMessage & { customType?: string }).customType !== "devflow-planning-context",
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

		const choice = await ctx.ui.select(`DevFlow — plan ready. Execute with ${refLabel(config.worker)}?`, [
			"Execute plan with worker model",
			"Refine the plan",
			"Stay in planning phase",
			"Abandon (restore previous model)",
		]);

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

	pi.on("agent_settled", async (_event, ctx) => {
		if (phase !== "executing") return;
		phase = "idle";
		updateStatus(ctx);

		if (config.keepWorkerAfterExecution || !modelBeforePlanning) {
			ctx.ui.notify("DevFlow execution run finished (worker model stays active).", "info");
			persistState();
			return;
		}

		// Restore the prime model the user had before planning.
		const restore = { ...modelBeforePlanning, thinking: ctx.thinkingLevel };
		modelBeforePlanning = undefined;
		if (await applyModel(restore, ctx)) {
			ctx.ui.notify(`DevFlow execution run finished. Restored prime model: ${refLabel(restore)}`, "info");
		} else {
			ctx.ui.notify("DevFlow execution run finished (could not restore prime model — worker stays active).", "warning");
		}
		persistState();
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
		const target = phase === "planning" ? config.planner : phase === "executing" ? config.worker : undefined;
		if (target) {
			if (phase === "planning") enablePlanningTools();
			const currentRef = { provider: ctx.model.provider, id: ctx.model.id };
			if (currentRef.provider !== target.provider || currentRef.id !== target.id) {
				await applyModel(target, ctx);
			}
		}
		updateStatus(ctx);
	});
}
