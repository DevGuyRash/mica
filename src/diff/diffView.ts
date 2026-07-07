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

function renderInline(el: HTMLElement, result: DiffResult): void {
	for (const hunk of result.hunks) {
		const h = el.createDiv({ cls: "mica-diff-hunk" });
		for (const c of hunk.changes) {
			const row = h.createDiv({ cls: `mica-diff-row is-${c.tag}` });
			row.createSpan({ cls: "mica-diff-gutter", text: sign(c.tag) });
			renderLine(row.createSpan({ cls: "mica-diff-text" }), c);
		}
	}
}

function renderSideBySide(el: HTMLElement, result: DiffResult): void {
	const table = el.createDiv({ cls: "mica-diff-sbs" });
	for (const hunk of result.hunks) {
		let dels: DiffChange[] = [];
		let inss: DiffChange[] = [];
		const flush = (): void => {
			const n = Math.max(dels.length, inss.length);
			for (let i = 0; i < n; i++) {
				const row = table.createDiv({ cls: "mica-diff-srow" });
				sideCell(row, dels[i], "delete");
				sideCell(row, inss[i], "insert");
			}
			dels = [];
			inss = [];
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
	if (c) renderLine(cell, c);
}

function renderLine(el: HTMLElement, c: DiffChange): void {
	if (c.inline.length) {
		c.inline.forEach((s, i) => {
			const text = i === c.inline.length - 1 ? stripEol(s.text) : s.text;
			el.createSpan({ cls: s.tag === "emph" ? "mica-diff-emph" : "", text });
		});
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
