import { Modal } from "obsidian";
import { calloutCatalog, type CalloutFold } from "./calloutCatalog";
import { MdEditor } from "./mdEditor";
import { buildToolbar } from "./toolbarView";
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
 * The structured callout editor: type, title, and fold as first-class fields;
 * the body edits WITHOUT its `> ` marks (re-quoted on save, so writing a
 * callout inside the body nests it one level automatically).
 */
export function openCalloutEditor(ctx: RenderCtx, target: RegionTarget): void {
	const parsed = parseCallout(target.original);
	if (!parsed) return;
	const modal = new (class extends Modal {
		private editor: MdEditor | null = null;

		onOpen(): void {
			this.modalEl.addClass("mica-callout-editor");
			this.titleEl.setText("Edit callout");
			const root = this.contentEl.createDiv({ cls: "mica-coedit-root" });

			// Type + fold + title row.
			const row = root.createDiv({ cls: "mica-coedit-row" });
			const typeInput = row.createEl("input", {
				cls: "mica-coedit-type",
				attr: { type: "text", list: "mica-callout-types", spellcheck: "false" },
			});
			typeInput.value = parsed.type;
			const datalist = row.createEl("datalist", { attr: { id: "mica-callout-types" } });
			for (const t of calloutCatalog(ctx.app)) datalist.createEl("option", { attr: { value: t.id } });

			let fold: CalloutFold = parsed.fold;
			const foldBtns: HTMLButtonElement[] = [];
			const foldOpt = (label: string, value: CalloutFold, tip: string): void => {
				const b = row.createEl("button", {
					cls: `clickable-icon mica-pop-seg ${value === fold ? "is-on" : ""}`,
					text: label,
					attr: { type: "button", "aria-label": tip },
				});
				b.addEventListener("click", () => {
					fold = value;
					foldBtns.forEach((x) => x.removeClass("is-on"));
					b.addClass("is-on");
				});
				foldBtns.push(b);
			};
			foldOpt("Static", "", "Always expanded");
			foldOpt("Open", "+", "Foldable, starts open");
			foldOpt("Closed", "-", "Foldable, starts collapsed");

			const titleInput = root.createEl("input", {
				cls: "mica-coedit-title",
				attr: { type: "text", placeholder: "Title (optional)" },
			});
			titleInput.value = parsed.title;

			// Body: markdown without the quote marks.
			const tools = root.createDiv({ cls: "mica-coedit-tools" });
			const host = root.createDiv({ cls: "mica-coedit-body" });
			this.editor = new MdEditor(host, {
				initial: parsed.body,
				placeholder: "Callout body — no > marks needed (a callout typed here nests automatically)",
				onSave: () => save(),
				onCancel: () => this.close(),
			});
			buildToolbar(tools, ctx.app, () => (this.editor as MdEditor).view, true);

			const footer = root.createDiv({ cls: "mica-coedit-footer" });
			footer.createSpan({
				cls: "mica-lightbox-hint",
				text: "Saved as a normal callout — the > marks are added for you.",
			});
			footer.createDiv({ cls: "mica-footer-spacer" });
			const cancel = footer.createEl("button", { text: "Cancel", attr: { type: "button" } });
			cancel.addEventListener("click", () => this.close());
			const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } });
			const save = (): void => {
				const type = typeInput.value.trim() || parsed.type;
				const rebuilt = buildCallout({
					type,
					fold,
					title: titleInput.value.trim(),
					body: this.editor?.getValue() ?? parsed.body,
					suffix: parsed.suffix,
				});
				this.close();
				if (rebuilt === target.original) return;
				ctx.editable?.apply({
					op: "saveRegion",
					path: target.path,
					start: target.start,
					end: target.end,
					expected: target.original,
					text: rebuilt,
				});
			};
			saveBtn.addEventListener("click", save);
		}

		onClose(): void {
			this.editor?.destroy();
			this.contentEl.empty();
		}
	})(ctx.app);
	modal.open();
}
