import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { FrontendSession, type Annotation } from "./session.ts";

/** Format annotations into compact lines for agent context (or /ui confirm). */
function formatAnnotations(annotations: Annotation[]): string[] {
	return annotations.map((a) => {
		const comp = a.components.find((c) => c.component || c.selector) ?? a.components[0];
		const where = comp ? `${comp.component ?? comp.selector ?? comp.tag}` : a.tag;
		return [
			`#${a.id} <${where}> "${a.note || "(no note)"}"`,
			`   selector: ${a.selector}`,
			`   page: ${a.url}`,
			a.screenshot ? `   screenshot: ${a.screenshot}` : null,
		]
			.filter(Boolean)
			.join("\n");
	});
}

/** Destructive / write-oriented bash patterns blocked while planning UI changes. */
const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<&0-9])>(?!>|&)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
];

function isDestructiveBash(command: string): boolean {
	return DESTRUCTIVE_BASH_PATTERNS.some((p) => p.test(command));
}

/** Injected on every agent turn while UI plan mode is active. */
const PLAN_MODE_CONTEXT = [
	"[UI PLAN MODE ACTIVE]",
	"You are planning UI changes in read-only mode.",
	"",
	"Restrictions:",
	"- edit and write tools are disabled",
	"- destructive or write-oriented bash commands are blocked",
	"",
	"Do NOT modify any files. Explore the relevant source, then produce a detailed, numbered implementation plan under a '## Plan' header. The user will run /ui confirm to implement it.",
].join("\n");

const DEFAULT_URL = "http://localhost:4200";

/** npm scripts most likely to start a dev server, ordered by preference. */
const PREFERRED_SCRIPTS = ["start", "dev", "serve", "dev:server", "serve:local"];

/** Actions offered when /ui is invoked without a subcommand. */
const UI_ACTIONS: Array<{ value: string; label: string }> = [
	{ value: "start", label: "start    Start dev server + open browser" },
	{ value: "annotate", label: "annotate    Toggle click-to-annotate mode" },
	{ value: "plan", label: "plan    Plan collected annotations (read-only)" },
	{ value: "confirm", label: "confirm    Implement collected annotations" },
	{ value: "status", label: "status    Show dev-server/browser/annotation status" },
	{ value: "stop", label: "stop    Close browser + stop server" },
	{ value: "shots", label: "shots    Show screenshot folder" },
];

export default function (pi: ExtensionAPI) {
	let session: FrontendSession | null = null;
	let ui: ExtensionContext["ui"] | null = null;

	// UI plan mode state (read-only planning before implementation).
	const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
	let planMode = false;
	let toolsBeforePlan: string[] | undefined;

	function requireSession(): FrontendSession {
		if (!session) throw new Error("No frontend session yet — call frontend_start first.");
		return session;
	}

	function updateStatus(): void {
		if (!ui || !session) return;
		const n = session.annotations.length;
		if (planMode) {
			ui.setStatus("ui-annotator", `⏸ UI plan mode${n > 0 ? ` · ${n} annotation(s)` : ""}`);
			return;
		}
		ui.setStatus("ui-annotator", n > 0 ? `UI annotations: ${n}` : undefined);
	}

	function persistPlanMode(): void {
		pi.appendEntry("ui-plan-mode", { planMode, toolsBeforePlan });
	}

	/** Enable read-only planning or restore full tools. */
	function setPlanMode(enabled: boolean): void {
		planMode = enabled;
		if (enabled) {
			if (toolsBeforePlan === undefined) toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(toolsBeforePlan.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)));
		} else {
			if (toolsBeforePlan !== undefined) {
				pi.setActiveTools(toolsBeforePlan);
				toolsBeforePlan = undefined;
			}
		}
		persistPlanMode();
		updateStatus();
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	async function resolveStartCommand(
		ctx: ExtensionContext,
		params: { script?: string; command?: string },
	): Promise<string> {
		if (params.command) return params.command;

		let scripts: Record<string, string> = {};
		try {
			scripts = JSON.parse(await readFile(join(ctx.cwd, "package.json"), "utf8")).scripts ?? {};
		} catch {
			// no package.json
		}
		const names = Object.keys(scripts);

		if (params.script) {
			if (!names.includes(params.script)) {
				throw new Error(
					`Script "${params.script}" not found in package.json. Available: ${names.join(", ") || "(none)"}`,
				);
			}
			return params.script === "start" ? "npm start" : `npm run ${params.script}`;
		}

		if (names.length === 0) return "npm start";

		// Ask the user which script starts the dev server.
		if (ctx.hasUI) {
			const ordered = [
				...PREFERRED_SCRIPTS.filter((s) => names.includes(s)),
				...names.filter((s) => !PREFERRED_SCRIPTS.includes(s)),
			];
			try {
				const pick = await ctx.ui.select(
					"Which npm script starts the frontend dev server?",
					ordered.map((n) => `${n}  →  ${scripts[n]}`),
				);
				if (pick) {
					const name = pick.split(/\s{2,}/)[0];
					return name === "start" ? "npm start" : `npm run ${name}`;
				}
			} catch {
				// fall through to heuristic
			}
		}

		const heuristic = PREFERRED_SCRIPTS.find((s) => names.includes(s)) ?? names[0];
		return heuristic === "start" ? "npm start" : `npm run ${heuristic}`;
	}

	/** Keep screenshots out of git when the project has a .gitignore. */
	async function ensureGitignore(cwd: string): Promise<void> {
		const entry = ".pi/annotations/";
		const gitignore = join(cwd, ".gitignore");
		try {
			if (!existsSync(gitignore)) return;
			const content = await readFile(gitignore, "utf8");
			if (!content.includes(entry)) {
				await appendFile(gitignore, `\n# pi ui-annotator screenshots\n${entry}\n`);
			}
		} catch {
			// best-effort
		}
	}

	async function startFrontend(ctx: ExtensionContext, params: {
		url?: string;
		script?: string;
		command?: string;
	}): Promise<string> {
		if (!session) throw new Error("Session not initialized.");
		const url = params.url ?? DEFAULT_URL;
		const command = await resolveStartCommand(ctx, params);
		await ensureGitignore(ctx.cwd);
		const serverMsg = await session.startServer(command, url, ctx.cwd);
		const browserMsg = await session.launchBrowser(url);
		return [
			serverMsg,
			browserMsg,
			"",
			"Next steps:",
			"- Call frontend_annotate with enable=true to let the user click and annotate elements.",
			"- When the user says they are done, call frontend_annotations to read what they marked.",
			"- Locate source files by grepping for the component class name or selector from each annotation.",
		].join("\n");
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : null;
		session = new FrontendSession(join(ctx.cwd, ".pi", "annotations"));
		session.onAnnotation = (annotation) => {
			updateStatus();
			ui?.notify(
				`Annotation #${annotation.id}: "${annotation.note || "(no note)"}" — ${annotation.selector}`,
				"info",
			);
		};

		// Restore plan-mode state across reloads/resumes.
		planMode = false;
		toolsBeforePlan = undefined;
		const planEntry = ctx.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === "ui-plan-mode")
			.pop() as { data?: { planMode?: boolean; toolsBeforePlan?: string[] } } | undefined;
		if (planEntry?.data?.planMode) {
			const before = planEntry.data.toolsBeforePlan ?? pi.getActiveTools();
			toolsBeforePlan = before;
			planMode = true;
			pi.setActiveTools(before.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)));
		}
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		if (session) {
			await session.stopAll();
			session = null;
		}
		ui = null;
	});

	// Inject unread annotations and/or plan-mode context before each agent turn.
	pi.on("before_agent_start", async () => {
		if (!session) return;
		const parts: string[] = [];
		let inject = false;

		if (session.unreadCount > 0) {
			const unread = session.annotations.slice(-session.unreadCount);
			session.markRead();
			updateStatus();
			const lines = formatAnnotations(unread);
			parts.push(
				[
					"The user annotated UI elements in the running frontend:",
					...lines,
					"",
					"Use the frontend_annotations tool for full details (HTML snippet, full component chain, embedded screenshots). " +
						"Locate source files by grepping for the component class name or declared selector (e.g. `selector: 'app-x'`).",
				].join("\n"),
			);
			inject = true;
		}

		if (planMode) {
			parts.push(PLAN_MODE_CONTEXT);
			inject = true;
		}

		if (!inject) return;
		return {
			message: {
				customType: "ui-annotator",
				display: true,
				content: parts.join("\n\n"),
			},
		};
	});

	// Enforce read-only behavior while UI plan mode is active.
	pi.on("tool_call", async (event) => {
		if (!planMode) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "UI plan mode is active — edits are disabled. Run /ui confirm to implement.",
			};
		}
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";
			if (isDestructiveBash(command)) {
				return {
					block: true,
					reason: `UI plan mode: write/destructive command blocked. Run /ui confirm to implement.\nCommand: ${command}`,
				};
			}
		}
	});

	// ---------------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "frontend_start",
		label: "Frontend Start",
		description:
			"Start the frontend dev server (asks the user which npm script to run unless specified) and open the app in a controlled Chrome browser for UI annotation.",
		promptSnippet: "Start the frontend dev server and open it in a controllable browser",
		promptGuidelines: [
			"Use frontend_start when the user wants to run the frontend and annotate or inspect the UI.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: `App URL (default ${DEFAULT_URL})` })),
			script: Type.Optional(
				Type.String({ description: "npm script name from package.json. If omitted, the user is asked." }),
			),
			command: Type.Optional(
				Type.String({ description: "Raw shell command override instead of an npm script" }),
			),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Starting dev server…" }] });
			const message = await startFrontend(ctx, params);
			return { content: [{ type: "text", text: message }], details: {} };
		},
	});

	pi.registerTool({
		name: "frontend_stop",
		label: "Frontend Stop",
		description: "Close the controlled browser and stop the dev server if the extension started it.",
		promptSnippet: "Stop the frontend dev server and controlled browser",
		parameters: Type.Object({}),
		async execute() {
			const result = await requireSession().stopAll();
			updateStatus();
			return {
				content: [
					{
						type: "text",
						text: `Stopped. Browser closed: ${result.browserClosed}, dev server killed: ${result.serverKilled}.`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "frontend_status",
		label: "Frontend Status",
		description: "Show dev server, browser, annotation, and console status for the frontend session.",
		promptSnippet: "Show frontend server/browser/annotation status",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: requireSession().status() }], details: {} };
		},
	});

	pi.registerTool({
		name: "frontend_navigate",
		label: "Frontend Navigate",
		description: "Navigate the controlled browser to a URL or app-relative route (e.g. '/login').",
		promptSnippet: "Navigate the controlled browser to a URL or route",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL or app-relative route like '/users'" }),
		}),
		async execute(_id, params) {
			const message = await requireSession().navigate(params.url);
			return { content: [{ type: "text", text: message }], details: {} };
		},
	});

	pi.registerTool({
		name: "frontend_annotate",
		label: "Frontend Annotate",
		description:
			"Enable or disable annotation pick mode in the controlled browser. While enabled, the user clicks elements in the UI and attaches notes; each annotation captures the CSS selector, Angular component chain, route, HTML snippet, and an element screenshot.",
		promptSnippet: "Toggle click-to-annotate mode in the controlled browser",
		promptGuidelines: [
			"Use frontend_annotate with enable=true when the user wants to mark up elements in the UI.",
			"After the user says they finished annotating, use frontend_annotations to read their annotations before making code changes.",
		],
		parameters: Type.Object({
			enable: Type.Boolean({ description: "true to enable pick mode, false to disable" }),
		}),
		async execute(_id, params) {
			const s = requireSession();
			const ok = await s.setAnnotate(params.enable);
			if (!ok) throw new Error("Could not toggle annotate mode — is the browser open and the page loaded?");
			const text = params.enable
				? `Annotate mode ON. The user can now click elements in the browser (Esc exits). ${s.annotations.length} annotations collected so far.`
				: `Annotate mode OFF. ${s.annotations.length} annotations collected so far.`;
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "frontend_annotations",
		label: "Frontend Annotations",
		description:
			"Read the UI annotations the user collected in the browser: note, CSS selector, Angular component chain (class name + declared selector in dev mode), page URL, text/HTML snippets, and screenshot paths.",
		promptSnippet: "Read UI annotations collected by the user in the browser",
		promptGuidelines: [
			"Use frontend_annotations when the user refers to elements they annotated in the UI; locate source files by grepping for the component class name or selector in each annotation.",
		],
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear all annotations after reading" })),
			includeImages: Type.Optional(
				Type.Boolean({ description: "Embed element screenshots as images you can see (max 8)" }),
			),
		}),
		async execute(_id, params) {
			const s = requireSession();
			if (s.annotations.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No annotations collected yet. Enable pick mode with frontend_annotate and ask the user to click elements in the browser.",
						},
					],
					details: {},
				};
			}

			const list = s.annotations.map((a) => ({
				id: a.id,
				note: a.note,
				selector: a.selector,
				tag: a.tag,
				components: a.components,
				url: a.url,
				text: a.text,
				html: a.html.slice(0, 1200),
				screenshot: a.screenshot,
			}));

			const content: Array<
				{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
			> = [
				{
					type: "text",
					text:
						`${s.annotations.length} UI annotation(s):\n\n` +
						JSON.stringify(list, null, 2) +
						"\n\nTo find the source: grep for the component class name (e.g. `class LoginComponent`) " +
						"or declared selector (e.g. `selector: 'app-login'`) under src/.",
				},
			];

			if (params.includeImages) {
				let attached = 0;
				for (const a of s.annotations) {
					if (attached >= 8) break;
					const base64 = await s.readScreenshotBase64(a);
					if (base64) {
						content.push({ type: "text", text: `Screenshot for annotation #${a.id}:` });
						content.push({ type: "image", data: base64, mimeType: "image/png" });
						attached++;
					}
				}
			}

			s.markRead();
			if (params.clear) s.clearAnnotations();
			updateStatus();
			return { content, details: { count: s.annotations.length } };
		},
	});

	pi.registerTool({
		name: "frontend_screenshot",
		label: "Frontend Screenshot",
		description:
			"Capture a screenshot from the controlled browser — full viewport, full page, a CSS selector, or a previously collected annotation — and view it as an image.",
		promptSnippet: "Capture and view a screenshot of the running frontend",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS selector of an element to capture" })),
			annotationId: Type.Optional(Type.Number({ description: "Capture the element of a collected annotation" })),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page" })),
		}),
		async execute(_id, params) {
			const s = requireSession();
			const { buffer, label, path } = await s.screenshot(params);
			return {
				content: [
					{ type: "text", text: `Screenshot of ${label} (saved to ${path}):` },
					{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
				],
				details: { path },
			};
		},
	});

	pi.registerTool({
		name: "frontend_console",
		label: "Frontend Console",
		description: "Read recent console messages and page errors captured from the controlled browser.",
		promptSnippet: "Read console output and page errors from the controlled browser",
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear the console buffer after reading" })),
		}),
		async execute(_id, params) {
			const s = requireSession();
			const entries = s.getConsole();
			const text =
				entries.length === 0
					? "No console output captured."
					: entries
							.map((e) => `[${new Date(e.time).toISOString()}] [${e.type}] ${e.text}`)
							.join("\n");
			if (params.clear) s.clearConsole();
			return { content: [{ type: "text", text }], details: { count: entries.length } };
		},
	});

	// ---------------------------------------------------------------------------
	// /ui command for direct user control
	// ---------------------------------------------------------------------------

	pi.registerCommand("ui", {
		description: "Control the UI annotator: /ui start [script] | stop | status | annotate [on|off] | plan | confirm | shots",
		getArgumentCompletions: (prefix) => {
			const items = ["start", "stop", "status", "annotate", "plan", "confirm", "shots"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!session) {
				ctx.ui.notify("No session", "error");
				return;
			}
			let [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			try {
				// No subcommand → show a picker (like /model) instead of defaulting to status.
				if (!sub && ctx.hasUI) {
					const pick = await ctx.ui.select(
						"ui — choose an action",
						UI_ACTIONS.map((a) => a.label),
					);
					sub = UI_ACTIONS.find((a) => a.label === pick)?.value;
					if (!sub) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
				}
				switch (sub) {
					case "start": {
						ctx.ui.notify("Starting frontend…", "info");
						const message = await startFrontend(ctx, { script: rest[0] });
						ctx.ui.notify(message.split("\n")[0], "info");
						break;
					}
					case "stop": {
						const result = await session.stopAll();
						ctx.ui.notify(
							`Stopped (browser closed: ${result.browserClosed}, server killed: ${result.serverKilled})`,
							"info",
						);
						break;
					}
					case "annotate": {
						const on = rest[0] !== "off";
						const ok = await session.setAnnotate(on);
						ctx.ui.notify(
							ok ? `Annotate mode ${on ? "ON" : "OFF"}` : "Could not toggle — is the page loaded?",
							ok ? "info" : "error",
						);
						break;
					}
					case "plan": {
						if (session.annotations.length === 0) {
							ctx.ui.notify("No annotations to plan — annotate first with /ui annotate.", "warning");
							break;
						}
						if (!planMode) setPlanMode(true);
						const lines = formatAnnotations(session.annotations);
						const count = session.annotations.length;
						session.markRead();
						updateStatus();
						await ctx.waitForIdle();
						pi.sendUserMessage(
							"Plan the implementation for the UI annotations I collected:\n\n" +
								lines.join("\n") +
								"\n\nUse frontend_annotations (with includeImages: true) for full details — HTML snippet, full component chain, and embedded screenshots. " +
								"Locate source files by grepping for the component class name or declared selector (e.g. `selector: 'app-x'`).\n\n" +
								"Do NOT make any changes yet. Explore the relevant source files, then produce a detailed, numbered plan under a '## Plan' header describing exactly which files you would edit and what you would change. " +
								"When it looks right, the user will run /ui confirm to implement it.",
						);
						ctx.ui.notify(`Plan mode ON — ${count} annotation(s) sent to the agent for planning. Run /ui confirm to implement.`, "info");
						break;
					}
					case "confirm": {
						if (session.annotations.length === 0) {
							ctx.ui.notify("No annotations to confirm — annotate first with /ui annotate.", "warning");
							break;
						}
						const wasPlanMode = planMode;
						if (wasPlanMode) setPlanMode(false);
						const lines = formatAnnotations(session.annotations);
						session.markRead();
						updateStatus();
						await ctx.waitForIdle();
						pi.sendUserMessage(
							"Implement the UI annotations I collected:\n\n" +
								lines.join("\n") +
								"\n\nUse frontend_annotations for full details (HTML snippet, component chain, embedded screenshots). " +
								"Locate source files by grepping for the component class name or declared selector (e.g. `selector: 'app-x'`) and make the changes." +
								(wasPlanMode ? "\n\nA plan was produced earlier under a '## Plan' header — follow it." : ""),
						);
						ctx.ui.notify(`Sent ${session.annotations.length} annotation(s) to the agent for implementation`, "info");
						break;
					}
					case "shots":
						ctx.ui.notify(`Screenshots in ${session.annotationsDir}`, "info");
						break;
					case "status":
					default:
						ctx.ui.notify(session.status().split("\n").slice(0, 3).join(" · "), "info");
						break;
				}
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
			updateStatus();
		},
	});
}
