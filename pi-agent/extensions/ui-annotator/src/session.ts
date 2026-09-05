import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { type DomPathStep, installPiPicker } from "./picker.ts";

export interface AnnotationComponent {
	tag: string;
	component?: string;
	selector?: string;
	framework?: string;
	renderer?: string;
}

export interface Annotation {
	id: number;
	note: string;
	framework?: string | null;
	selector: string;
	domPath: DomPathStep[];
	tag: string;
	components: AnnotationComponent[];
	url: string;
	title: string;
	rect: { x: number; y: number; width: number; height: number };
	text: string;
	html: string;
	timestamp: number;
	screenshot?: string;
}

export interface ConsoleEntry {
	type: string;
	text: string;
	time: number;
}

const MAX_CONSOLE_ENTRIES = 200;
const MAX_SERVER_LOG_LINES = 200;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isUp(url: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1500);
		const res = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		return res.status < 500;
	} catch {
		return false;
	}
}

function errorMessage(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

// Persistent profile dir: puppeteer only auto-deletes temp profiles it
// created, and that cleanup hits EBUSY on Windows (Chrome child processes
// linger). An explicit userDataDir is never deleted — and keeps the user
// logged into the app between sessions as a bonus.
const PROFILE_DIR = join(tmpdir(), "pi-ui-annotator-chrome-profile");

const CHROME_ARGS = ["--start-maximized", "--disable-session-crashed-bubble", "--hide-crash-restore-bubble"];

/** Locate an installed Chrome/Edge without downloading a browser. */
function findBrowserExecutable(): string | null {
	const envPath = process.env.PI_CHROME_PATH;
	if (envPath && existsSync(envPath)) return envPath;

	// "msedge" is a valid runtime channel, but the installed puppeteer-core
	// typings restrict executablePath() to Chrome channels; widen the signature.
	const executablePath = puppeteer.executablePath as (channel: string) => string;
	for (const channel of ["chrome", "msedge"] as const) {
		try {
			const p = executablePath(channel);
			if (existsSync(p)) return p;
		} catch {
			// channel not installed
		}
	}

	const candidates = [
		process.env.LOCALAPPDATA
			? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
			: undefined,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	].filter((p): p is string => Boolean(p));
	return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Reattach to a Chrome that is still running on the pi profile — e.g. one
 * left behind when a previous pi process was killed. Launching a second
 * Chrome on a profile that is in use just hands the URL to the running
 * instance and exits (code 21), which puppeteer reports as the misleading
 * "Failed to launch the browser process! undefined".
 */
async function connectToRunningChrome(userDataDir: string): Promise<Browser | null> {
	const portFile = join(userDataDir, "DevToolsActivePort");
	if (!existsSync(portFile)) return null;
	try {
		const port = (await readFile(portFile, "utf8")).split(/\r?\n/)[0]?.trim();
		if (!port || !/^\d+$/.test(port)) return null;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1500);
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return null;
		const info = (await res.json()) as { webSocketDebuggerUrl?: string };
		if (!info.webSocketDebuggerUrl) return null;
		return await puppeteer.connect({ browserWSEndpoint: info.webSocketDebuggerUrl, defaultViewport: null });
	} catch {
		return null; // stale port file — that Chrome is gone; launch a fresh one
	}
}

/** Reuse a Chrome still running on the pi profile, or launch the installed Chrome/Edge. */
async function launchChrome(): Promise<{ browser: Browser; reused: boolean }> {
	const running = await connectToRunningChrome(PROFILE_DIR);
	if (running) return { browser: running, reused: true };

	const executablePath = findBrowserExecutable();
	if (!executablePath) {
		throw new Error(
			"No Chrome or Edge installation found. Install Chrome, or set the PI_CHROME_PATH environment variable to your browser executable.",
		);
	}
	try {
		const browser = await puppeteer.launch({
			executablePath,
			headless: false,
			defaultViewport: null,
			args: CHROME_ARGS,
			userDataDir: PROFILE_DIR,
		});
		return { browser, reused: false };
	} catch (err) {
		throw new Error(
			`Failed to launch ${executablePath}: ${errorMessage(err)} ` +
				`— if a Chrome window from an earlier pi session is still open on the pi profile (${PROFILE_DIR}), close it and retry.`,
		);
	}
}

/**
 * Owns the dev-server child process, the controlled browser, and the
 * annotation store for one pi session.
 */
export class FrontendSession {
	private serverProc?: ChildProcess;
	private browser?: Browser;
	private page?: Page;
	private serverLogLines: string[] = [];
	private consoleEntries: ConsoleEntry[] = [];
	private serverStartedByUs = false;
	private appUrl = "";

	readonly annotations: Annotation[] = [];
	unreadCount = 0;
	annotationsDir: string;
	onAnnotation?: (annotation: Annotation) => void;

	constructor(annotationsDir: string) {
		this.annotationsDir = annotationsDir;
	}

	// -------------------------------------------------------------------------
	// Dev server
	// -------------------------------------------------------------------------

	isServerRunning(): boolean {
		return Boolean(this.serverProc) || this.appUrl !== "";
	}

	tailServerLog(lines = 15): string {
		return this.serverLogLines.slice(-lines).join("\n");
	}

	private pushServerOutput(chunk: string): void {
		for (const line of chunk.split(/\r?\n/)) {
			if (line.trim()) this.serverLogLines.push(line);
		}
		if (this.serverLogLines.length > MAX_SERVER_LOG_LINES) {
			this.serverLogLines.splice(0, this.serverLogLines.length - MAX_SERVER_LOG_LINES);
		}
	}

	async startServer(command: string, url: string, cwd: string, timeoutMs = 180_000): Promise<string> {
		if (await isUp(url)) {
			this.appUrl = url;
			this.serverStartedByUs = false;
			return `A server is already responding at ${url} — reusing it (not spawning \`${command}\`).`;
		}

		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/sh";
		const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
		this.serverProc = spawn(shell, shellArgs, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.serverStartedByUs = true;
		this.serverProc.stdout?.on("data", (d) => this.pushServerOutput(String(d)));
		this.serverProc.stderr?.on("data", (d) => this.pushServerOutput(String(d)));
		this.serverProc.on("exit", (code) => {
			this.pushServerOutput(`[dev server exited with code ${code}]`);
			this.serverProc = undefined;
		});

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await isUp(url)) {
				this.appUrl = url;
				return `Started \`${command}\` — ready at ${url}.`;
			}
			if (!this.serverProc) {
				throw new Error(
					`Dev server exited before ${url} became ready. Recent output:\n${this.tailServerLog()}`,
				);
			}
			await sleep(1000);
		}
		throw new Error(`Timed out waiting for ${url}. Recent output:\n${this.tailServerLog()}`);
	}

	// -------------------------------------------------------------------------
	// Browser
	// -------------------------------------------------------------------------

	isBrowserOpen(): boolean {
		return Boolean(this.browser?.isConnected() && this.page && !this.page.isClosed());
	}

	async launchBrowser(url: string): Promise<string> {
		if (this.isBrowserOpen()) {
			await this.navigate(url);
			return `Browser already open — navigated to ${url}.`;
		}
		const { browser, reused } = await launchChrome();
		this.browser = browser;
		const existing = await browser.pages();
		// A reused browser still carries the previous session's pages (and their
		// __piAnnotate bindings) — start from a fresh page and drop the old ones.
		const page = reused ? await browser.newPage() : (existing[0] ?? (await browser.newPage()));
		if (reused) {
			for (const old of existing) await old.close().catch(() => {});
		}
		this.page = page;

		await page.exposeFunction("__piAnnotate", (payload: Record<string, unknown>) => {
			void this.receiveAnnotation(payload);
		});
		await page.evaluateOnNewDocument(installPiPicker);
		page.on("console", (msg) => this.pushConsole(msg.type(), msg.text()));
		page.on("pageerror", (err) => this.pushConsole("pageerror", String(err)));

		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
		this.appUrl = url;
		return reused
			? `Reconnected to the Chrome still running on the pi profile and opened ${url}.`
			: `Browser opened at ${url}.`;
	}

	async navigate(url: string): Promise<string> {
		const page = this.requirePage();
		let target = url;
		if (!/^https?:\/\//i.test(target)) {
			const base = this.appUrl || "http://localhost:4200";
			target = new URL(target, base).toString();
		}
		await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
		this.appUrl = target;
		return `Navigated to ${target} (title: ${await page.title()}).`;
	}

	private requirePage(): Page {
		if (!this.page || this.page.isClosed()) {
			throw new Error("Browser is not open. Run frontend_start first.");
		}
		return this.page;
	}

	// -------------------------------------------------------------------------
	// Annotations
	// -------------------------------------------------------------------------

	private async receiveAnnotation(payload: Record<string, unknown>): Promise<void> {
		const id = this.annotations.length + 1;
		const annotation: Annotation = { ...(payload as Omit<Annotation, "id">), id };
		await mkdir(this.annotationsDir, { recursive: true });
		try {
			const shot = await this.screenshotByPath(annotation.domPath);
			if (shot) {
				const file = join(this.annotationsDir, `annotation-${id}.png`);
				await writeFile(file, shot);
				annotation.screenshot = file;
			}
		} catch {
			// screenshot is best-effort; keep the annotation regardless
		}
		this.annotations.push(annotation);
		this.unreadCount++;
		this.onAnnotation?.(annotation);
	}

	private async screenshotByPath(domPath: DomPathStep[]): Promise<Buffer | null> {
		if (!this.isBrowserOpen()) return null;
		const page = this.requirePage();
		try {
			const clip = await page.evaluate((p: DomPathStep[]) => {
				const api = (window as any).__piPicker;
				const el = api?.findByPath(p);
				if (!el) return null;
				api.hideUi(true);
				el.scrollIntoView({ block: "center", inline: "center" });
				const r = el.getBoundingClientRect();
				const pad = 8;
				const x = Math.max(0, r.left - pad);
				const y = Math.max(0, r.top - pad);
				return {
					x,
					y,
					width: Math.min(r.width + pad * 2, window.innerWidth - x),
					height: Math.min(r.height + pad * 2, window.innerHeight - y),
				};
			}, domPath);
			if (!clip || clip.width < 2 || clip.height < 2) return null;
			await sleep(80); // let the overlay hide before capturing
			return Buffer.from(await page.screenshot({ clip }));
		} catch {
			return null;
		} finally {
			try {
				await page.evaluate(() => (window as any).__piPicker?.hideUi(false));
			} catch {
				// page may have navigated; ignore
			}
		}
	}

	markRead(): void {
		this.unreadCount = 0;
	}

	clearAnnotations(): number {
		const n = this.annotations.length;
		this.annotations.length = 0;
		this.unreadCount = 0;
		return n;
	}

	async readScreenshotBase64(annotation: Annotation): Promise<string | null> {
		if (!annotation.screenshot || !existsSync(annotation.screenshot)) return null;
		return (await readFile(annotation.screenshot)).toString("base64");
	}

	// -------------------------------------------------------------------------
	// Annotate mode / screenshots / console
	// -------------------------------------------------------------------------

	async setAnnotate(on: boolean): Promise<boolean> {
		const page = this.requirePage();
		let ok = await page.evaluate((enable: boolean) => {
			const api = (window as any).__piPicker;
			if (!api) return false;
			api.setActive(enable);
			return true;
		}, on);
		if (!ok) {
			// Page may predate the injection (e.g. restored tab) — install now.
			await page.evaluate(installPiPicker);
			ok = await page.evaluate((enable: boolean) => {
				const api = (window as any).__piPicker;
				if (!api) return false;
				api.setActive(enable);
				return true;
			}, on);
		}
		return ok;
	}

	async screenshot(opts: {
		selector?: string;
		fullPage?: boolean;
		annotationId?: number;
	}): Promise<{ buffer: Buffer; label: string; path: string }> {
		await mkdir(this.annotationsDir, { recursive: true });
		let buffer: Buffer | null = null;
		let label: string;

		if (opts.annotationId != null) {
			const annotation = this.annotations.find((a) => a.id === opts.annotationId);
			if (!annotation) throw new Error(`No annotation with id ${opts.annotationId}.`);
			buffer = await this.screenshotByPath(annotation.domPath);
			if (!buffer) throw new Error(`Could not locate element for annotation #${annotation.id} on the current page.`);
			label = `annotation #${annotation.id} (${annotation.selector})`;
		} else if (opts.selector) {
			const page = this.requirePage();
			const handle = await page.$(opts.selector);
			if (!handle) throw new Error(`No element matches selector: ${opts.selector}`);
			await page.evaluate(() => (window as any).__piPicker?.hideUi(true));
			await sleep(80);
			buffer = Buffer.from(await handle.screenshot());
			await page.evaluate(() => (window as any).__piPicker?.hideUi(false));
			label = `element ${opts.selector}`;
		} else {
			const page = this.requirePage();
			buffer = Buffer.from(await page.screenshot({ fullPage: opts.fullPage ?? false }));
			label = opts.fullPage ? "full page" : "viewport";
		}

		const path = join(this.annotationsDir, `screenshot-${Date.now()}.png`);
		await writeFile(path, buffer);
		return { buffer, label, path };
	}

	private pushConsole(type: string, text: string): void {
		this.consoleEntries.push({ type, text: text.slice(0, 500), time: Date.now() });
		if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
			this.consoleEntries.splice(0, this.consoleEntries.length - MAX_CONSOLE_ENTRIES);
		}
	}

	getConsole(): ConsoleEntry[] {
		return this.consoleEntries;
	}

	clearConsole(): void {
		this.consoleEntries.length = 0;
	}

	// -------------------------------------------------------------------------
	// Status / shutdown
	// -------------------------------------------------------------------------

	status(): string {
		const lines = [
			`Dev server: ${this.serverProc ? "running (started by extension)" : this.appUrl ? `responding at ${this.appUrl} (external)` : "not running"}`,
			`Browser: ${this.isBrowserOpen() ? `open at ${this.page?.url()}` : "closed"}`,
			`Annotations: ${this.annotations.length} collected (${this.unreadCount} unread)`,
			`Console entries captured: ${this.consoleEntries.length}`,
		];
		const logTail = this.tailServerLog(10);
		if (logTail) lines.push("", "Recent dev server output:", logTail);
		return lines.join("\n");
	}

	async stopAll(): Promise<{ browserClosed: boolean; serverKilled: boolean }> {
		let browserClosed = false;
		let serverKilled = false;
		if (this.browser) {
			try {
				await this.browser.close();
				browserClosed = true;
			} catch {
				// already closed — force-kill the process if we still have it
				try {
					this.browser.process()?.kill("SIGKILL");
				} catch {
					// ignore
				}
			}
			this.browser = undefined;
			this.page = undefined;
		}
		if (this.serverProc) {
			const proc = this.serverProc;
			this.serverProc = undefined;
			serverKilled = true;
			if (process.platform === "win32" && proc.pid) {
				spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
			} else {
				proc.kill("SIGTERM");
			}
		}
		this.appUrl = "";
		return { browserClosed, serverKilled };
	}
}
