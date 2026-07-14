import { setIcon } from "obsidian";
import { calloutCatalog, type CalloutFold, type CalloutType } from "./calloutCatalog";
import { EditorLightbox } from "./lightbox";
import { buildCalloutTypeGrid } from "./toolbarView";
import type { RenderCtx } from "./blockShell";
import type { RegionTarget } from "./quickEdit";

/** A callout region decomposed for structured editing. */
export interface ParsedCallout {
	type: string;
	fold: CalloutFold;
	title: string;
	/** Body with ONE level of `> ` stripped — a nested callout inside shows
	 *  as a plain callout here and round-trips back to `> >` on save. */
	body: string;
	/** Raw text after the quoted run (glued trailing blank lines) — byte-exact. */
	suffix: string;
}

const HEAD_RE = /^(\s{0,3})> ?\[!([A-Za-z0-9-]+)\]([+-]?)[ \t]?([^\n]*)/;

/** Parse a region's text as a single leading callout, or null. */
export function parseCallout(original: string): ParsedCallout | null {
	const m = original.match(HEAD_RE);
	if (!m) return null;
	// Walk the quoted continuation lines by offset so `suffix` stays exact.
	let pos = original.indexOf("\n", m[0].length);
	if (pos === -1) pos = original.length;
	else pos += 1;
	const body: string[] = [];
	while (pos < original.length) {
		const eol = original.indexOf("\n", pos);
		const end = eol === -1 ? original.length : eol;
		const line = original.slice(pos, end);
		if (!/^\s{0,3}>/.test(line)) break;
		body.push(line.replace(/^\s{0,3}> ?/, ""));
		pos = eol === -1 ? original.length : eol + 1;
	}
	return {
		type: m[2],
		fold: (m[3] as CalloutFold) ?? "",
		title: m[4].trim(),
		body: body.join("\n"),
		suffix: original.slice(pos),
	};
}

/** Reassemble a callout region (each body line re-quoted with one `> `). */
export function buildCallout(c: ParsedCallout): string {
	const head = `> [!${c.type}]${c.fold}${c.title ? ` ${c.title}` : ""}\n`;
	const body = c.body.length
		? `${c.body
				.split("\n")
				.map((l) => (l.length ? `> ${l}` : ">"))
				.join("\n")}\n`
		: "";
	return `${head}${body}${c.suffix}`;
}

/**
 * The structured callout editor — an `EditorLightbox` derivative. Type, title,
 * and fold are header fields; the body edits WITHOUT its `> ` marks and the
 * live preview renders the ASSEMBLED callout. Re-quoting on save means a
 * callout typed inside the body nests one level automatically.
 */
export function openCalloutEditor(ctx: RenderCtx, target: RegionTarget): void {
	const parsed = parseCallout(target.original);
	if (!parsed) return;
	// Mutable field state shared by the header hook and the save/preview paths.
	const state = { type: parsed.type, fold: parsed.fold, title: parsed.title };
	const assemble = (body: string): string =>
		buildCallout({ ...state, body, suffix: parsed.suffix });

	new EditorLightbox({
		app: ctx.app,
		title: "Edit callout",
		initial: parsed.body,
		sourcePath: ctx.sourcePath,
		previewTransform: assemble,
		header: (host, refresh) => {
			const row = host.createDiv({ cls: "mica-coedit-row" });

			// Type: current icon + name in the type's real (theme-driven) color;
			// clicking opens the same searchable grid the toolbar uses.
			const typeBtn = row.createEl("button", {
				cls: "clickable-icon mica-coedit-type",
				attr: { type: "button", "aria-label": "Change callout type" },
			});
			const paintType = (): void => {
				const t: CalloutType | undefined = calloutCatalog(ctx.app).find(
					(x) => x.id === state.type || x.aliases.includes(state.type),
				);
				typeBtn.empty();
				typeBtn.style.setProperty("--mica-co-color", t?.color ?? "var(--mica-accent)");
				setIcon(typeBtn.createSpan({ cls: "mica-callout-ico" }), t?.icon ?? "megaphone");
				typeBtn.createSpan({ cls: "mica-callout-name", text: state.type });
				setIcon(typeBtn.createSpan({ cls: "mica-coedit-caret" }), "chevron-down");
			};
			paintType();
			typeBtn.addEventListener("click", () => {
				host.querySelector(".mica-popover")?.remove();
				const panel = row.createDiv({ cls: "mica-popover mica-coedit-typepop" });
				const close = (): void => {
					panel.remove();
					document.removeEventListener("pointerdown", onOut, true);
				};
				const onOut = (ev: PointerEvent): void => {
					if (!panel.contains(ev.target as Node)) close();
				};
				document.addEventListener("pointerdown", onOut, true);
				buildCalloutTypeGrid(panel, ctx.app, (t) => {
					state.type = t.id;
					paintType();
					refresh();
					close();
				});
			});

			const foldBtns: HTMLButtonElement[] = [];
			const foldOpt = (label: string, value: CalloutFold, tip: string): void => {
				const b = row.createEl("button", {
					cls: `clickable-icon mica-pop-seg ${value === state.fold ? "is-on" : ""}`,
					text: label,
					attr: { type: "button", "aria-label": tip },
				});
				b.addEventListener("click", () => {
					state.fold = value;
					foldBtns.forEach((x) => x.removeClass("is-on"));
					b.addClass("is-on");
					refresh();
				});
				foldBtns.push(b);
			};
			foldOpt("Static", "", "Always expanded");
			foldOpt("Open", "+", "Foldable, starts open");
			foldOpt("Closed", "-", "Foldable, starts collapsed");

			const titleInput = row.createEl("input", {
				cls: "mica-coedit-title",
				attr: { type: "text", placeholder: "Title (optional)" },
			});
			titleInput.value = state.title;
			titleInput.addEventListener("input", () => {
				state.title = titleInput.value.trim();
				refresh();
			});
		},
		onSave: (body) => {
			const rebuilt = assemble(body);
			if (rebuilt === target.original) return;
			ctx.editable?.apply({
				op: "saveRegion",
				path: target.path,
				start: target.start,
				end: target.end,
				expected: target.original,
				text: rebuilt,
			});
		},
	}).open();
}
