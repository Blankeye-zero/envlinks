/**
 * Notepad — workspace notes: storage, /note quick-append, /notes manager.
 *
 * Notes live in one plain file per workspace: `.pi/notes.md` (CONFIG_DIR_NAME),
 * as an appended numbered list:
 *
 *   1. fix the login bug
 *   2. ask about pg ssl modes
 *     continuation lines are indented
 *
 * The file is the single source of truth — edit it in any editor.
 * Note numbers are stable: deleting a note leaves a gap, and the next
 * appended note continues from the highest number ever present.
 *
 * Viewing: focus-cycle.ts renders a read-only "notes" panel in its Tab cycle
 * (input → chat → reasoning → notes → input) using the helpers below.
 * Managing: the /notes command opens a type-to-filter picker with
 * edit/delete/add operations. Every mutation emits "notepad:changed" on
 * pi.events so a browsing notes panel refreshes live (same pattern as
 * devflow:config → reasoning-panel).
 *
 * Commands:
 *   /note <text>   Append <text> as the next numbered note (quotes optional).
 *   /notes         Manage notes: type to filter, enter → edit/delete, or add.
 */

import { CONFIG_DIR_NAME, DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Storage helpers (stateless — every function takes the workspace cwd)
// ---------------------------------------------------------------------------

export function notesPathFor(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "notes.md");
}

export function readNotes(cwd: string): string {
	try {
		const path = notesPathFor(cwd);
		if (!existsSync(path)) return "";
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Highest existing note number in the content (0 when there are none). */
export function nextNoteNumber(content: string): number {
	let max = 0;
	for (const line of content.split("\n")) {
		const m = /^\s*(\d+)\.[ \t]/.exec(line);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return max;
}

/** Atomic write of the notes file (temp file + rename). Ensures trailing newline. */
export function writeNotes(cwd: string, text: string): void {
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	const path = notesPathFor(cwd);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${text.trimEnd()}\n`);
	renameSync(tmp, path);
}

/**
 * Append `text` as the next numbered note. Multi-line text is kept together:
 * the first line gets the number, continuation lines are indented two spaces.
 * Returns the assigned note number.
 */
export function appendNote(cwd: string, text: string): number {
	const current = readNotes(cwd);
	const n = nextNoteNumber(current) + 1;
	const numbered = text
		.trimEnd()
		.split("\n")
		.map((line, i) => (i === 0 ? `${n}. ${line}` : `  ${line}`))
		.join("\n");
	const existing = current.trimEnd();
	writeNotes(cwd, existing ? `${existing}\n${numbered}` : numbered);
	return n;
}

/** Strip one surrounding pair of matching double or single quotes. */
export function stripQuotes(s: string): string {
	if (
		s.length >= 2 &&
		((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
	) {
		return s.slice(1, -1);
	}
	return s;
}

// ---------------------------------------------------------------------------
// Structured access (parse → modify → serialize), numbers preserved
// ---------------------------------------------------------------------------

export interface ParsedNote {
	number: number;
	/** First element is the note's first line; the rest are continuation lines (unindented). */
	lines: string[];
}

/**
 * Parse the notes file. A line matching `N. text` starts a note; following
 * indented lines belong to it. Blank and unrecognised lines are dropped.
 */
export function parseNotes(content: string): ParsedNote[] {
	const notes: ParsedNote[] = [];
	for (const line of content.split("\n")) {
		const m = /^\s*(\d+)\.[ \t](.*)$/.exec(line);
		if (m) {
			notes.push({ number: Number(m[1]), lines: [m[2] ?? ""] });
		} else if (notes.length > 0 && /^\s+\S/.test(line)) {
			notes[notes.length - 1]!.lines.push(line.trim());
		}
	}
	return notes;
}

export function serializeNotes(notes: ParsedNote[]): string {
	return notes
		.map((n) => {
			const [first = "", ...rest] = n.lines;
			const head = `${n.number}. ${first}`;
			return rest.length > 0 ? `${head}\n${rest.map((l) => `  ${l}`).join("\n")}` : head;
		})
		.join("\n");
}

export function setNotes(cwd: string, notes: ParsedNote[]): void {
	writeNotes(cwd, serializeNotes(notes));
}

/** Replace a note's text; an empty/whitespace text deletes the note instead. */
export function replaceNote(cwd: string, number: number, text: string): void {
	const notes = parseNotes(readNotes(cwd));
	const note = notes.find((n) => n.number === number);
	if (!note) return;
	if (!text.trim()) {
		setNotes(cwd, notes.filter((n) => n.number !== number));
		return;
	}
	note.lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
	setNotes(cwd, notes);
}

export function deleteNote(cwd: string, number: number): void {
	const notes = parseNotes(readNotes(cwd));
	setNotes(cwd, notes.filter((n) => n.number !== number));
}

// ---------------------------------------------------------------------------
// /notes picker — SelectList with type-to-filter
// ---------------------------------------------------------------------------

type PickResult = { type: "add" } | { type: "note"; note: ParsedNote } | null;

const ADD_VALUE = "__add__";

function noteToItem(note: ParsedNote): SelectItem {
	const firstLine = (note.lines[0] ?? "").trim() || "(empty)";
	// value carries number + full text so substring filtering searches both;
	// the list renders label + description only.
	return { value: `${note.number} ${note.lines.join(" ")}`, label: `#${note.number}`, description: firstLine };
}

async function pickNote(ctx: ExtensionContext, notes: ParsedNote[]): Promise<PickResult> {
	return ctx.ui.custom<PickResult>((tui, theme, _kb, done) => {
		const container = new Container();
		const borderFn = (s: string) => theme.fg("accent", s);

		const title = new Text("", 1, 0);
		const filterLine = new Text("", 1, 0);
		const hints = new Text("", 1, 0);

		const allItems = notes.map(noteToItem);
		let filter = "";
		let list: SelectList | undefined;

		// Rebuilds the whole container each time the filter changes — SelectList
		// has no setItems, and Container only appends, so re-lay out in order.
		const rebuild = () => {
			const f = filter.toLowerCase();
			const items = f ? allItems.filter((i) => i.value.toLowerCase().includes(f)) : [...allItems];
			items.push({ value: ADD_VALUE, label: "+ Add new note" });

			container.clear();
			container.addChild(new DynamicBorder(borderFn));
			container.addChild(title);
			container.addChild(filterLine);

			const next = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			next.onSelect = (item) => {
				if (item.value === ADD_VALUE) {
					done({ type: "add" });
					return;
				}
				const num = Number(item.label.slice(1));
				const note = notes.find((n) => n.number === num);
				done(note ? { type: "note", note } : null);
			};
			next.onCancel = () => {
				if (filter) {
					filter = "";
					rebuild();
				} else {
					done(null);
				}
			};

			list = next;
			container.addChild(list);

			title.setText(theme.fg("accent", theme.bold(` Notes — ${notes.length} note${notes.length === 1 ? "" : "s"} `)) + theme.fg("dim", `(${CONFIG_DIR_NAME}/notes.md)`));
			filterLine.setText(filter ? theme.fg("muted", ` filter: ${filter}`) : theme.fg("dim", " type to filter"));
			hints.setText(theme.fg("dim", " ↑↓ navigate · enter select · esc " + (filter ? "clear filter" : "close")));
			container.addChild(hints);

			container.addChild(new DynamicBorder(borderFn));
			container.invalidate();
		};
		rebuild();

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data.length === 1 && data >= " ") {
					filter += data;
					rebuild();
				} else if (matchesKey(data, "backspace") && filter) {
					filter = filter.slice(0, -1);
					rebuild();
				} else {
					list?.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("note", {
		description: "Append a note to the workspace notes file: /note <text> (view: /browse notes or Tab)",
		handler: async (args, ctx) => {
			const text = stripQuotes(args.trim());
			if (!text) {
				ctx.ui.notify("Usage: /note <text>  (view: /browse notes or Tab)", "info");
				return;
			}
			const n = appendNote(ctx.cwd, text);
			pi.events.emit("notepad:changed", { cwd: ctx.cwd });
			ctx.ui.notify(`Note #${n} appended → ${CONFIG_DIR_NAME}/notes.md`, "info");
		},
	});

	pi.registerCommand("notes", {
		description: "Manage workspace notes — type to filter, then edit, delete, or add",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				const count = parseNotes(readNotes(ctx.cwd)).length;
				ctx.ui.notify(
					count > 0 ? `${count} note(s) in ${CONFIG_DIR_NAME}/notes.md` : "No notes yet — /note <text> to add one",
					"info",
				);
				return;
			}

			const changed = () => pi.events.emit("notepad:changed", { cwd: ctx.cwd });

			for (;;) {
				const notes = parseNotes(readNotes(ctx.cwd));
				const picked = await pickNote(ctx, notes);
				if (!picked) return;

				if (picked.type === "add") {
					const text = await ctx.ui.editor("New note — Esc cancels", "");
					if (text && text.trim().length > 0) {
						const n = appendNote(ctx.cwd, text);
						changed();
						ctx.ui.notify(`Note #${n} appended`, "info");
					}
					continue;
				}

				const note = picked.note;
				const firstLine = (note.lines[0] ?? "").trim();
				const choice = await ctx.ui.select(`Note #${note.number} — ${firstLine.slice(0, 50)}`, [
					"Edit",
					"Delete",
					"Back",
				]);

				if (choice === "Edit") {
					const text = await ctx.ui.editor(
						`Edit note #${note.number} — Esc cancels, empty deletes`,
						note.lines.join("\n"),
					);
					if (text === undefined) continue;
					if (text.trim().length > 0) {
						replaceNote(ctx.cwd, note.number, text);
						changed();
						ctx.ui.notify(`Note #${note.number} updated`, "info");
					} else {
						deleteNote(ctx.cwd, note.number);
						changed();
						ctx.ui.notify(`Note #${note.number} deleted`, "info");
					}
				} else if (choice === "Delete") {
					if (await ctx.ui.confirm(`Delete note #${note.number}?`, firstLine)) {
						deleteNote(ctx.cwd, note.number);
						changed();
						ctx.ui.notify(`Note #${note.number} deleted`, "info");
					}
				}
				// "Back" or Esc → loop back to the picker
			}
		},
	});
}
