import type { EditorView } from "@codemirror/view";
import type { CalloutFold } from "./calloutCatalog";

/**
 * Markdown editing verbs for the Mica editor toolbar. Every verb is a pure
 * function of the live `EditorView` — selection-aware, toggle-friendly, and
 * nesting-correct (callouts deepen `>` quoting; code fences out-size any
 * fence they contain, mirroring how the core sizes the outer ` ```mica ` fence).
 */

/** Wrap or unwrap the selection with a symmetric inline marker (`**`, `==`, …). */
export function toggleInline(view: EditorView, marker: string): void {
	const { state } = view;
	const sel = state.selection.main;
	const from = sel.from;
	const to = sel.to;
	const text = state.sliceDoc(from, to);
	const m = marker.length;

	// Unwrap when the selection (or its immediate surroundings) already carries the marker.
	if (text.startsWith(marker) && text.endsWith(marker) && text.length >= 2 * m) {
		view.dispatch({
			changes: { from, to, insert: text.slice(m, text.length - m) },
			selection: { anchor: from, head: to - 2 * m },
		});
		return;
	}
	if (state.sliceDoc(from - m, from) === marker && state.sliceDoc(to, to + m) === marker) {
		view.dispatch({
			changes: [
				{ from: from - m, to: from, insert: "" },
				{ from: to, to: to + m, insert: "" },
			],
			selection: { anchor: from - m, head: to - m },
		});
		return;
	}
	view.dispatch({
		changes: { from, to, insert: `${marker}${text}${marker}` },
		selection: text ? { anchor: from, head: to + 2 * m } : { anchor: from + m },
	});
	view.focus();
}

/** The full lines covered by the selection, as `{from, to, text}`. */
function selectedLines(view: EditorView): { from: number; to: number; lines: string[] } {
	const { state } = view;
	const sel = state.selection.main;
	const first = state.doc.lineAt(sel.from);
	const last = state.doc.lineAt(sel.to);
	const lines: string[] = [];
	for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n).text);
	return { from: first.from, to: last.to, lines };
}

function replaceLines(view: EditorView, from: number, to: number, lines: string[]): void {
	const insert = lines.join("\n");
	view.dispatch({
		changes: { from, to, insert },
		selection: { anchor: from, head: from + insert.length },
	});
	view.focus();
}

/** Toggle an ATX heading of `level` on every selected line. */
export function setHeading(view: EditorView, level: number): void {
	const { from, to, lines } = selectedLines(view);
	const prefix = "#".repeat(level) + " ";
	const all = lines.every((l) => l.startsWith(prefix));
	replaceLines(
		view,
		from,
		to,
		lines.map((l) => {
			const bare = l.replace(/^#{1,6} /, "");
			return all ? bare : prefix + bare;
		}),
	);
}

/** Toggle a list prefix on every selected line: `bullet`, `ordered`, or `task`. */
export function toggleList(view: EditorView, kind: "bullet" | "ordered" | "task"): void {
	const { from, to, lines } = selectedLines(view);
	const strip = (l: string): string => l.replace(/^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/, "$1");
	const has = (l: string): boolean =>
		kind === "task"
			? /^\s*[-*+] \[[ xX]\] /.test(l)
			: kind === "bullet"
				? /^\s*[-*+] (?!\[)/.test(l)
				: /^\s*\d+[.)] /.test(l);
	const all = lines.every((l) => !l.trim() || has(l));
	let n = 0;
	replaceLines(
		view,
		from,
		to,
		lines.map((l) => {
			if (!l.trim()) return l;
			const bare = strip(l);
			if (all) return bare;
			const indent = /^\s*/.exec(bare)?.[0] ?? "";
			const rest = bare.slice(indent.length);
			n += 1;
			if (kind === "task") return `${indent}- [ ] ${rest}`;
			if (kind === "ordered") return `${indent}${n}. ${rest}`;
			return `${indent}- ${rest}`;
		}),
	);
}

/** Deepen the blockquote level of every selected line (or unquote when all quoted). */
export function toggleQuote(view: EditorView): void {
	const { from, to, lines } = selectedLines(view);
	const all = lines.every((l) => !l.trim() || l.startsWith(">"));
	replaceLines(
		view,
		from,
		to,
		lines.map((l) => {
			if (!l.trim() && !all) return l;
			if (all) return l.replace(/^> ?/, "");
			return `> ${l}`;
		}),
	);
}

/**
 * Wrap the selection in a callout of `type`. Already-quoted lines simply gain
 * a level (`> ` prefix stacks), so callout-in-callout nests correctly.
 */
export function insertCallout(view: EditorView, type: string, fold: CalloutFold, title: string): void {
	const { from, to, lines } = selectedLines(view);
	const body = (lines.length === 1 && !lines[0].trim() ? [""] : lines).map((l) => (l.trim() ? `> ${l}` : ">"));
	const header = `> [!${type}]${fold}${title ? ` ${title}` : ""}`;
	const insert = [header, ...body].join("\n");
	view.dispatch({
		changes: { from, to, insert },
		// Land the caret at the body's start so typing continues inside the callout.
		selection: { anchor: from + header.length + 1 + (body[0] === ">" ? 1 : 2) },
	});
	view.focus();
}

/**
 * Wrap the selection in a fenced code block. The fence is one backtick longer
 * than any backtick run inside the selection (min 3), so fencing code that
 * itself contains fences can never break — the same rule the Rust core applies
 * to the outer ` ```mica ` fence.
 */
export function insertCodeblock(view: EditorView, lang: string): void {
	const { from, to, lines } = selectedLines(view);
	const body = lines.join("\n");
	let maxRun = 0;
	for (const m of body.matchAll(/`+/g)) maxRun = Math.max(maxRun, m[0].length);
	const fence = "`".repeat(Math.max(3, maxRun + 1));
	const insert = `${fence}${lang}\n${body.trim() ? body : ""}${body.trim() ? "\n" : ""}${fence}`;
	view.dispatch({
		changes: { from, to, insert },
		selection: { anchor: from + fence.length + lang.length + 1 },
	});
	view.focus();
}

/** Wrap the selection as a markdown link and select the URL placeholder. */
export function insertLink(view: EditorView): void {
	const sel = view.state.selection.main;
	const text = view.state.sliceDoc(sel.from, sel.to) || "link text";
	const insert = `[${text}](url)`;
	const urlStart = sel.from + text.length + 3;
	view.dispatch({
		changes: { from: sel.from, to: sel.to, insert },
		selection: { anchor: urlStart, head: urlStart + 3 },
	});
	view.focus();
}

/** Wrap the selection as a wikilink. */
export function insertWikilink(view: EditorView): void {
	const sel = view.state.selection.main;
	const text = view.state.sliceDoc(sel.from, sel.to);
	view.dispatch({
		changes: { from: sel.from, to: sel.to, insert: `[[${text}]]` },
		selection: text ? { anchor: sel.from, head: sel.to + 4 } : { anchor: sel.from + 2 },
	});
	view.focus();
}

/** Insert a starter table on its own paragraph. */
export function insertTable(view: EditorView): void {
	const sel = view.state.selection.main;
	const line = view.state.doc.lineAt(sel.from);
	const table = "| Column | Column |\n| ------ | ------ |\n| Cell   | Cell   |";
	const insert = (line.text.trim() ? "\n\n" : "") + table + "\n";
	view.dispatch({
		changes: { from: line.to, to: line.to, insert },
		selection: { anchor: line.to + insert.indexOf("Column") },
	});
	view.focus();
}

/** Insert a horizontal rule on its own paragraph. */
export function insertHr(view: EditorView): void {
	const sel = view.state.selection.main;
	const line = view.state.doc.lineAt(sel.from);
	const insert = (line.text.trim() ? "\n\n" : "") + "---\n";
	view.dispatch({ changes: { from: line.to, to: line.to, insert } });
	view.focus();
}
