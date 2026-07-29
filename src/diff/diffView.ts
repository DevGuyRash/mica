import type { DiffChange, DiffResult } from "../wasm/bridge";

export type DiffMode = "inline" | "side-by-side";

/** Render a diff result into `el` in the given mode. */
export function renderDiff(el: HTMLElement, result: DiffResult, mode: DiffMode): void {
	el.empty();
	el.addClass("mica-diff");
	el.toggleClass("is-sbs", mode === "side-by-side");
	if (mode === "side-by-side") {
		renderSideBySide(el, result);
	} else {
		renderInline(el, result);
	}
}

/** Render a unified-diff patch as monospace text. */
export function renderPatch(el: HTMLElement, patch: string): void {
	el.empty();
	el.addClass("mica-diff");
	el.createEl("pre", { cls: "mica-diff-patchtext", text: patch });
}

/** The grid is inherently side-by-side; the layout chooses what each column
 * *says*. `inline` shows the unified diff (what changed); `side-by-side` shows
 * each version's own content with changes emphasized (what it now reads like). */
export type NUpGridLayout = "inline" | "side-by-side";

/** N-up compare: the base column plus one column per version. */
export function renderNUp(
	el: HTMLElement,
	base: { label: string; text: string },
	columns: { label: string; result: DiffResult }[],
	layout: NUpGridLayout = "inline",
): void {
	el.empty();
	el.addClass("mica-diff");
	el.toggleClass("is-sbs", layout === "side-by-side");
	const grid = el.createDiv({ cls: "mica-diff-nup" });
	grid.style.setProperty("--mica-nup-cols", String(columns.length + 1));
	grid.createDiv({ cls: "mica-diff-nup-head", text: `${base.label} (base)` });
	for (const c of columns) grid.createDiv({ cls: "mica-diff-nup-head", text: c.label });
	const baseCell = grid.createDiv({ cls: "mica-diff-nup-col" });
	baseCell.createEl("pre", { cls: "mica-diff-basetext", text: base.text });
	for (const c of columns) {
		const col = grid.createDiv({ cls: "mica-diff-nup-col" });
		if (layout === "side-by-side") renderTargetSide(col, c.result);
		else renderInline(col, c.result);
	}
}

/** N-up compare as stacked unified patches. Stacking has no column budget, so
 * this is the layout that can show every picked version at once. */
export function renderNUpPatch(el: HTMLElement, baseLabel: string, columns: { label: string; patch: string }[]): void {
	el.empty();
	el.addClass("mica-diff");
	const stack = el.createDiv({ cls: "mica-diff-stack" });
	for (const c of columns) {
		const section = stack.createDiv({ cls: "mica-diff-stack-item" });
		section.createDiv({ cls: "mica-diff-stack-head", text: `${baseLabel} → ${c.label}` });
		section.createEl("pre", { cls: "mica-diff-patchtext", text: c.patch || "No differences." });
	}
}

/** One column of a side-by-side n-up: the target's own lines, with inserts
 * emphasized and a blank row wherever the base line was deleted, so columns
 * stay roughly aligned against the base without an N-way alignment pass. */
function renderTargetSide(el: HTMLElement, result: DiffResult): void {
	for (const hunk of result.hunks) {
		const h = el.createDiv({ cls: "mica-diff-hunk" });
		for (const c of hunk.changes) {
			if (c.tag === "delete") {
				h.createDiv({ cls: "mica-diff-row is-empty" });
				continue;
			}
			const row = h.createDiv({ cls: `mica-diff-row is-${c.tag}` });
			if (isDirectiveLine(c.value)) row.addClass("is-directive");
			renderLine(row.createSpan({ cls: "mica-diff-text" }), c);
		}
	}
}

/** Layout plumbing (`:::`, `tab:`) reads as noise in a diff — dim it. */
function isDirectiveLine(value: string): boolean {
	const t = value.trim();
	return t.startsWith(":::") || t.startsWith("tab:");
}

function renderInline(el: HTMLElement, result: DiffResult): void {
	for (const hunk of result.hunks) {
		const h = el.createDiv({ cls: "mica-diff-hunk" });
		for (const c of hunk.changes) {
			const row = h.createDiv({ cls: `mica-diff-row is-${c.tag}` });
			if (isDirectiveLine(c.value)) row.addClass("is-directive");
			row.createSpan({ cls: "mica-diff-gutter", text: sign(c.tag) });
			renderLine(row.createSpan({ cls: "mica-diff-text" }), c);
		}
	}
}

function renderSideBySide(el: HTMLElement, result: DiffResult): void {
	const table = el.createDiv({ cls: "mica-diff-sbs" });
	for (const hunk of result.hunks) {
		const dels: DiffChange[] = [];
		const inss: DiffChange[] = [];
		const flush = (): void => {
			const n = Math.max(dels.length, inss.length);
			for (let i = 0; i < n; i++) {
				const row = table.createDiv({ cls: "mica-diff-srow" });
				sideCell(row, dels[i], "delete");
				sideCell(row, inss[i], "insert");
			}
			dels.length = 0;
			inss.length = 0;
		};
		for (const c of hunk.changes) {
			if (c.tag === "equal") {
				flush();
				const row = table.createDiv({ cls: "mica-diff-srow is-equal" });
				sideCell(row, c, "equal");
				sideCell(row, c, "equal");
			} else if (c.tag === "delete") {
				dels.push(c);
			} else {
				inss.push(c);
			}
		}
		flush();
	}
}

function sideCell(row: HTMLElement, c: DiffChange | undefined, kind: string): void {
	const cell = row.createDiv({ cls: `mica-diff-cell is-${c ? kind : "empty"}` });
	if (c && isDirectiveLine(c.value)) cell.addClass("is-directive");
	if (c) renderLine(cell, c);
}

function renderLine(el: HTMLElement, c: DiffChange): void {
	if (c.inline.length) {
		for (let i = 0; i < c.inline.length; i++) {
			const s = c.inline[i];
			const text = i === c.inline.length - 1 ? stripEol(s.text) : s.text;
			el.createSpan({ cls: s.tag === "emph" ? "mica-diff-emph" : "", text });
		}
	} else {
		el.setText(stripEol(c.value));
	}
}

function stripEol(s: string): string {
	return s.endsWith("\n") ? s.slice(0, -1) : s;
}

function sign(tag: DiffChange["tag"]): string {
	return tag === "delete" ? "-" : tag === "insert" ? "+" : " ";
}
