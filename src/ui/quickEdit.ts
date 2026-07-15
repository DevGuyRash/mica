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

// ---------------------------------------------------------------------------
// Open-editor registry: click-outside behavior + save-all semantics
// ---------------------------------------------------------------------------

export type ClickOutsideMode = "nothing" | "cancel" | "save";

let clickOutsideMode: ClickOutsideMode = "nothing";

/** Called from settings load/change — how clicking outside an editor acts. */
export function setEditorBehavior(mode: ClickOutsideMode): void {
	clickOutsideMode = mode;
}

interface OpenEditor {
	region: HTMLElement;
	target: RegionTarget;
	getValue: () => string;
	applyOp: (value: string) => void;
	/** Destroy the editor locally (no doc change, draft cleared). */
	closeLocal: () => void;
	/** The editor's own cancel path (dirty editors arm "Discard?"). */
	cancel: () => void;
}

const openEditors = new Set<OpenEditor>();

/** Later regions first, so earlier splices can't shift later targets. */
function byDocOrderDesc(a: OpenEditor, b: OpenEditor): number {
	const pa = a.target.path;
	const pb = b.target.path;
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pb[i] ?? -1) - (pa[i] ?? -1);
		if (d) return d;
	}
	return b.target.start - a.target.start;
}

/**
 * Commit EVERY open editor (the user asked that one Save closes them all).
 * Values are snapshotted before any op runs — the first apply re-renders the
 * block and destroys the other editors' DOM.
 */
export function commitAllOpen(): void {
	sweepDetached();
	const jobs = [...openEditors].map((e) => ({ e, value: e.getValue() }));
	for (const { e } of jobs) e.closeLocal();
	jobs.filter((j) => j.value !== j.e.target.original)
		.sort((a, b) => byDocOrderDesc(a.e, b.e))
		.forEach((j) => j.e.applyOp(j.value));
}

/** Widget rebuilds (mode flips, cursor overlap) can destroy an editor's DOM
 *  without unregistering it — drop entries whose region left the document. */
function sweepDetached(): void {
	for (const ed of [...openEditors]) if (!ed.region.isConnected) openEditors.delete(ed);
}

function onDocPointerDown(e: PointerEvent): void {
	if (!openEditors.size) return;
	sweepDetached();
	if (clickOutsideMode === "nothing" || !openEditors.size) return;
	const t = e.target as HTMLElement | null;
	if (!t) return;
	// Menus, modals, and toolbar popovers belong to the editing session.
	if (t.closest(".menu, .modal, .mica-popover, .suggestion-container")) return;
	for (const ed of [...openEditors]) {
		if (ed.region.contains(t)) continue;
		if (clickOutsideMode === "save") {
			const value = ed.getValue();
			ed.closeLocal();
			if (value !== ed.target.original) ed.applyOp(value);
		} else {
			ed.closeLocal();
		}
	}
}
document.addEventListener("pointerdown", onDocPointerDown, true);

/** Escape cancels the most recent open editor even when focus is elsewhere
 *  (the editor's own keymap only sees Esc while focused). Modals, menus,
 *  and suggesters keep their own Esc. */
function onDocKeydown(e: KeyboardEvent): void {
	if (e.key !== "Escape" || !openEditors.size) return;
	sweepDetached();
	if (!openEditors.size) return;
	if (document.querySelector(".modal-container, .menu, .suggestion-container, .mica-popover, .mica-navpop")) return;
	const t = e.target as HTMLElement | null;
	for (const ed of openEditors) if (t && ed.region.contains(t)) return; // focused: its keymap owns Esc
	const last = [...openEditors].pop();
	if (!last) return;
	e.preventDefault();
	e.stopPropagation();
	last.cancel();
}
document.addEventListener("keydown", onDocKeydown, true);

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
		cls: "clickable-icon mica-qe-expand",
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
		openEditors.delete(entry);
		setDraft(null);
		editor.destroy();
		region.removeClass("is-editing");
		ctx.repaintRegion?.(region, target);
	};

	const entry: OpenEditor = {
		region,
		target,
		cancel: () => requestCancel(),
		getValue: () => editor.getValue(),
		applyOp: (value) =>
			ctx.editable?.apply({
				op: "saveRegion",
				path: target.path,
				start: target.start,
				end: target.end,
				expected: target.original,
				text: value,
			}),
		closeLocal: closeToView,
	};
	openEditors.add(entry);

	// One Save commits every open editor (registry semantics).
	const commit = (): void => commitAllOpen();

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
		openEditors.delete(entry);
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
