/**
 * Browser-side annotation picker.
 *
 * Injected into every document via page.evaluateOnNewDocument(installPiPicker).
 * Puppeteer serializes this function with Function.prototype.toString(), so the
 * body must be fully self-contained: no imports, no module-scope references.
 *
 * Communicates with Node via window.__piAnnotate (installed by
 * page.exposeFunction) and exposes window.__piPicker for Node-side control.
 */

export interface DomPathStep {
	tag: string;
	index: number;
}

export interface PickerApi {
	setActive(on: boolean): void;
	isActive(): boolean;
	hideUi(hide: boolean): void;
	findByPath(path: DomPathStep[]): Element | null;
}

export function installPiPicker(): void {
	const w = window as any;
	if (window.top !== window) return; // top frame only
	if (w.__piPicker) return;

	const doc = document;

	let active = false;
	let dialogOpen = false;
	let collected = 0;
	let hovered: Element | null = null;
	let frozen: Element | null = null;

	// ---------------------------------------------------------------------------
	// DOM helpers
	// ---------------------------------------------------------------------------

	function mk(tag: string, styles: Partial<CSSStyleDeclaration>, parent: Element): HTMLElement {
		const e = doc.createElement(tag);
		Object.assign(e.style, styles);
		parent.appendChild(e);
		return e;
	}

	// ---------------------------------------------------------------------------
	// Element metadata collection
	// ---------------------------------------------------------------------------

	function buildSelector(el: Element): string {
		const parts: string[] = [];
		let cur: Element | null = el;
		while (cur && cur.nodeType === 1 && cur !== doc.documentElement && parts.length < 8) {
			let part = cur.tagName.toLowerCase();
			const id = cur.getAttribute("id");
			if (id && !/^\d/.test(id)) {
				part = "#" + (w.CSS && CSS.escape ? CSS.escape(id) : id);
				parts.unshift(part);
				break;
			}
			const classes = (cur.getAttribute("class") || "")
				.trim()
				.split(/\s+/)
				.filter((c) => c && !c.startsWith("ng-") && !c.startsWith("_ng"))
				.slice(0, 2);
			if (classes.length > 0) {
				part += "." + classes.map((c) => (w.CSS && CSS.escape ? CSS.escape(c) : c)).join(".");
			}
			const parent: Element | null = cur.parentElement;
			if (!parent) break;
			const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
			if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
			parts.unshift(part);
			cur = parent;
		}
		return parts.join(" > ");
	}

	function buildDomPath(el: Element): DomPathStep[] {
		const path: DomPathStep[] = [];
		let cur: Element | null = el;
		while (cur && cur !== doc.documentElement) {
			const parent: Element | null = cur.parentElement;
			if (!parent) break;
			const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
			path.unshift({ tag: cur.tagName.toLowerCase(), index: sameTag.indexOf(cur) });
			cur = parent;
		}
		return path;
	}

	function findByPath(path: DomPathStep[]): Element | null {
		let cur: Element | null = doc.documentElement;
		for (const step of path) {
			if (!cur) return null;
			const sameTag = Array.from(cur.children).filter(
				(c) => c.tagName.toLowerCase() === step.tag,
			);
			cur = sameTag[step.index] || null;
		}
		return cur;
	}

	/** Walk ancestors collecting Angular component host info. */
	function angularChain(el: Element): Array<Record<string, string>> {
		const chain: Array<Record<string, string>> = [];
		let cur: Element | null = el;
		const ng = w.ng; // Angular dev-mode debug API
		while (cur && cur !== doc.body && chain.length < 6) {
			let isHost = false;
			if (cur.attributes) {
				for (const attr of Array.from(cur.attributes)) {
					if (attr.name.startsWith("_nghost")) {
						isHost = true;
						break;
					}
				}
			}
			if (!isHost && cur.tagName.includes("-")) isHost = true;
			if (isHost) {
				const entry: Record<string, string> = { tag: cur.tagName.toLowerCase() };
				try {
					const comp = ng && ng.getComponent ? ng.getComponent(cur) : null;
					if (comp) {
						const ctor = comp.constructor as any;
						if (ctor && ctor.name) entry.component = ctor.name;
						const def = ctor && ctor.ɵcmp;
						const sels = def && def.selectors;
						if (sels && sels[0] && sels[0][0]) entry.selector = sels[0][0];
					}
				} catch {
					// prod builds may not expose debug APIs; host tag is still useful
				}
				chain.push(entry);
			}
			cur = cur.parentElement;
		}
		return chain;
	}

	function collectPayload(target: Element, note: string): Record<string, unknown> {
		const rect = target.getBoundingClientRect();
		return {
			note,
			selector: buildSelector(target),
			domPath: buildDomPath(target),
			tag: target.tagName.toLowerCase(),
			components: angularChain(target),
			url: location.href,
			title: doc.title,
			rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
			text: (target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
			html: (target.outerHTML || "").slice(0, 2000),
			timestamp: Date.now(),
		};
	}

	// ---------------------------------------------------------------------------
	// Overlay UI (created lazily once <body> exists)
	// ---------------------------------------------------------------------------

	let highlight: HTMLElement;
	let badge: HTMLElement;
	let dialogHost: HTMLElement;
	let noteArea: HTMLTextAreaElement;
	let dialogLabel: HTMLElement;

	function updateBadge(): void {
		if (!badge) return;
		badge.style.display = active ? "block" : "none";
		badge.textContent = "pi annotate: ON · " + collected + " collected · click an element · Esc exits";
	}

	function moveHighlight(target: Element): void {
		if (!highlight) return;
		const r = target.getBoundingClientRect();
		highlight.style.display = "block";
		highlight.style.left = r.left + "px";
		highlight.style.top = r.top + "px";
		highlight.style.width = r.width + "px";
		highlight.style.height = r.height + "px";
		highlight.style.borderColor = frozen ? "#059669" : "#7c3aed";
	}

	function hideHighlight(): void {
		if (highlight) highlight.style.display = "none";
	}

	function openDialog(target: Element): void {
		if (!dialogHost) return;
		dialogOpen = true;
		dialogLabel.textContent = buildSelector(target);
		noteArea.value = "";
		dialogHost.style.display = "flex";
		setTimeout(() => noteArea.focus(), 0);
	}

	function closeDialog(): void {
		dialogOpen = false;
		frozen = null;
		if (dialogHost) dialogHost.style.display = "none";
	}

	function submitDialog(): void {
		if (!frozen) {
			closeDialog();
			return;
		}
		const payload = collectPayload(frozen, noteArea.value.trim());
		collected++;
		try {
			if (typeof w.__piAnnotate === "function") w.__piAnnotate(payload);
		} catch {
			// binding not ready; annotation lost but picker stays usable
		}
		closeDialog();
		updateBadge();
	}

	function isOurUi(target: EventTarget | null): boolean {
		return target === badge || target === dialogHost || target === highlight;
	}

	function setActive(on: boolean): void {
		active = on;
		if (!on) {
			closeDialog();
			hideHighlight();
		}
		updateBadge();
	}

	function hideUi(hide: boolean): void {
		if (hide) {
			if (highlight) highlight.style.visibility = "hidden";
			if (badge) badge.style.visibility = "hidden";
			if (dialogHost) dialogHost.style.visibility = "hidden";
		} else {
			if (highlight) highlight.style.visibility = "";
			if (badge) badge.style.visibility = "";
			if (dialogHost) dialogHost.style.visibility = "";
		}
	}

	function boot(): void {
		if (!doc.body) return;
		if (highlight) return; // already booted

		highlight = mk(
			"div",
			{
				position: "fixed",
				pointerEvents: "none",
				zIndex: "2147483645",
				border: "2px solid #7c3aed",
				background: "rgba(124, 58, 237, 0.10)",
				display: "none",
				borderRadius: "3px",
			},
			doc.body,
		);

		badge = mk(
			"div",
			{
				position: "fixed",
				bottom: "12px",
				right: "12px",
				zIndex: "2147483646",
				background: "#1f2937",
				color: "#e5e7eb",
				font: "12px/1.4 monospace",
				padding: "6px 10px",
				borderRadius: "6px",
				boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
				display: "none",
				pointerEvents: "none",
			},
			doc.body,
		);

		dialogHost = mk(
			"div",
			{
				position: "fixed",
				inset: "0",
				zIndex: "2147483647",
				display: "none",
				alignItems: "center",
				justifyContent: "center",
				background: "rgba(0,0,0,0.25)",
			},
			doc.body,
		);
		const shadow = dialogHost.attachShadow({ mode: "open" });
		shadow.innerHTML =
			"<style>" +
			".panel{background:#111827;color:#e5e7eb;font:13px/1.5 system-ui,sans-serif;" +
			"padding:16px;border-radius:10px;width:420px;box-shadow:0 8px 30px rgba(0,0,0,0.5);}" +
			".label{font-family:monospace;font-size:11px;color:#a78bfa;word-break:break-all;" +
			"margin-bottom:8px;max-height:60px;overflow:hidden;}" +
			"textarea{width:100%;box-sizing:border-box;height:80px;background:#1f2937;color:#e5e7eb;" +
			"border:1px solid #374151;border-radius:6px;padding:8px;font:13px system-ui,sans-serif;resize:vertical;}" +
			".row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;}" +
			"button{border:0;border-radius:6px;padding:6px 14px;cursor:pointer;font:13px system-ui,sans-serif;}" +
			".save{background:#7c3aed;color:#fff;}.cancel{background:#374151;color:#e5e7eb;}" +
			"</style>" +
			'<div class="panel"><div class="label"></div>' +
			'<textarea placeholder="What should change here? (Enter to save, Shift+Enter for newline, Esc to cancel)"></textarea>' +
			'<div class="row"><button class="cancel">Cancel</button><button class="save">Save annotation</button></div></div>';

		dialogLabel = shadow.querySelector(".label") as unknown as HTMLElement;
		noteArea = shadow.querySelector("textarea") as unknown as HTMLTextAreaElement;
		(shadow.querySelector(".save") as HTMLElement).addEventListener("click", submitDialog);
		(shadow.querySelector(".cancel") as HTMLElement).addEventListener("click", closeDialog);
		noteArea.addEventListener("keydown", (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				submitDialog();
			} else if (e.key === "Escape") {
				e.preventDefault();
				closeDialog();
			}
		});

		updateBadge();
	}

	// ---------------------------------------------------------------------------
	// Global listeners (registered once; UI booted lazily)
	// ---------------------------------------------------------------------------

	w.addEventListener(
		"mousemove",
		(e: MouseEvent) => {
			if (!active || dialogOpen || !highlight) return;
			const t = e.target as Element | null;
			if (!t || isOurUi(t)) return;
			hovered = t;
			moveHighlight(t);
		},
		true,
	);

	w.addEventListener(
		"click",
		(e: MouseEvent) => {
			if (!active || dialogOpen) return;
			const t = (e.target as Element | null) ?? hovered;
			if (!t || isOurUi(e.target)) return;
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
			frozen = t;
			moveHighlight(t);
			openDialog(t);
		},
		true,
	);

	w.addEventListener(
		"keydown",
		(e: KeyboardEvent) => {
			if (dialogOpen) return; // dialog handles its own keys
			if (e.key === "Escape" && active) {
				e.preventDefault();
				e.stopPropagation();
				setActive(false);
			}
		},
		true,
	);

	w.__piPicker = {
		setActive,
		isActive: () => active,
		hideUi,
		findByPath,
	};

	// evaluateOnNewDocument runs before <body> exists; defer UI creation.
	if (doc.readyState === "loading") {
		doc.addEventListener("DOMContentLoaded", boot, { once: true });
	} else {
		boot();
	}
}
