import { setIcon } from "obsidian";
import type { RenderCtx } from "./blockShell";
import { EditorLightbox } from "./lightbox";
import { MdEditor } from "./mdEditor";
import { buildToolbar } from "./toolbarView";

export interface RegionTarget {
	path: number[];
	start: number;
	end: number;
	original: string;
}

/** The draft key for a region (drafts survive widget rebuilds + mode flips). */
export function draftKey(t: RegionTarget): string {
	return `${t.path.join(",")}:${t.start}:${t.end}`;
}

/**
 * The inline quick editor: a compact CodeMirror markdown editor with a mini
 * toolbar and a PINNED action bar on top (targets never move while the editor
 * grows). Blur never commits; drafts are mirrored onto the block's UI state so
 * a widget rebuild or a mode flip reopens the editor with nothing lost.
 */
export function openQuickEdit(region: HTMLElement, ctx: RenderCtx, target: RegionTarget, initial?: string): void {
	if (region.hasClass("is-editing")) return;
	region.empty();
	region.removeClass("is-editable");
	region.addClass("is-editing");

	const key = draftKey(target);
	const setDraft = (text: string | null): void => {
		if (!ctx.ui) return;
		ctx.ui.draft = text === null ? null : { key, text };
	};

	// --- Action bar (TOP, fixed): Save · Cancel · spacer · tools · Expand ----
	const bar = region.createDiv({ cls: "mica-qe-bar" });
	const save = bar.createEl("button", { cls: "mod-cta mica-qe-save", text: "Save", attr: { type: "button" } });
	const cancel = bar.createEl("button", { cls: "mica-qe-cancel", text: "Cancel", attr: { type: "button" } });
	const tools = bar.createDiv({ cls: "mica-qe-tools" });
	bar.createDiv({ cls: "mica-footer-spacer" });
	const expand = bar.createEl("button", {
		cls: "mica-qe-expand",
		attr: { type: "button", "aria-label": "Open in the full editor (Ctrl+click a region does this directly)" },
	});
	setIcon(expand, "maximize-2");

	const host = region.createDiv({ cls: "mica-qe-host" });
	if (!(ctx.editorAutosize ?? true)) host.addClass("is-fixed");

	let discardArmed = false;
	const disarm = (): void => {
		if (!discardArmed) return;
		discardArmed = false;
		cancel.removeClass("mica-danger");
		cancel.setText("Cancel");
	};

	const editor = new MdEditor(host, {
		initial: initial ?? target.original,
		placeholder: "Write markdown — Ctrl+Enter saves, Esc cancels",
		onSave: () => commit(),
		onCancel: () => requestCancel(),
		onChange: (v) => {
			disarm();
			setDraft(v === target.original ? null : v);
		},
	});

	buildToolbar(tools, ctx.app, () => editor.view, true);

	const closeToView = (): void => {
		setDraft(null);
		editor.destroy();
		region.removeClass("is-editing");
		ctx.repaintRegion?.(region, target);
	};

	const commit = (): void => {
		const val = editor.getValue();
		if (val === target.original) {
			closeToView();
			return;
		}
		setDraft(null);
		editor.destroy();
		region.removeClass("is-editing");
		ctx.editable?.apply({
			op: "saveRegion",
			path: target.path,
			start: target.start,
			end: target.end,
			expected: target.original,
			text: val,
		});
	};

	const requestCancel = (): void => {
		if (editor.getValue() === target.original || discardArmed) {
			closeToView();
			return;
		}
		discardArmed = true;
		cancel.addClass("mica-danger");
		cancel.setText("Discard?");
		window.setTimeout(disarm, 2500);
	};

	save.addEventListener("mousedown", (e) => e.preventDefault());
	save.addEventListener("click", commit);
	cancel.addEventListener("mousedown", (e) => e.preventDefault());
	cancel.addEventListener("click", requestCancel);
	expand.addEventListener("mousedown", (e) => e.preventDefault());
	expand.addEventListener("click", () => {
		const value = editor.getValue();
		editor.destroy();
		region.removeClass("is-editing");
		ctx.repaintRegion?.(region, target);
		openLightboxFor(ctx, target, value);
	});
}

/** The full-screen editor for a region (Expand, or Ctrl/Cmd+click). */
export function openLightboxFor(ctx: RenderCtx, target: RegionTarget, initial?: string): void {
	const key = draftKey(target);
	new EditorLightbox({
		app: ctx.app,
		title: "Edit region",
		initial: initial ?? ctx.ui?.draft?.text ?? target.original,
		sourcePath: ctx.sourcePath,
		onDraft: (v) => {
			if (ctx.ui) ctx.ui.draft = v === target.original ? null : { key, text: v };
		},
		onDiscard: () => {
			if (ctx.ui?.draft?.key === key) ctx.ui.draft = null;
		},
		onSave: (value) => {
			if (ctx.ui?.draft?.key === key) ctx.ui.draft = null;
			if (value === target.original) return;
			ctx.editable?.apply({
				op: "saveRegion",
				path: target.path,
				start: target.start,
				end: target.end,
				expected: target.original,
				text: value,
			});
		},
	}).open();
}
