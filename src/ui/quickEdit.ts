import { Notice, setIcon } from "obsidian";
import type { StructOp } from "../cst/ops";
import type { MicaNode } from "../wasm/bridge";
import type { RenderCtx } from "./blockShell";
import { EditorLightbox } from "./lightbox";
import { editorViewPrefs, MdEditor, saveShortcutLabel, toggleViewPref } from "./mdEditor";
import { buildToolbar } from "./toolbarView";
import { mountActionMenu, type ActionSpec } from "./actionMenu";

export interface RegionTarget {
	path: number[];
	start: number;
	end: number;
	original: string;
	/** A `:::section` renders as one logical region while edits still target its
	 * inner leaf run. Structural actions use this exact outer node preimage. */
	logical?: { path: number[]; source: string; node: MicaNode };
}

/** The draft key for a region (drafts survive widget rebuilds + mode flips). */
export function draftKey(t: RegionTarget): string {
	return `${t.path.join(",")}:${t.start}`;
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
	blockOrder: number;
	region: HTMLElement;
	target: RegionTarget;
	getValue: () => string;
	applyOp: (value: string) => boolean;
	applyMany: (ops: readonly StructOp[]) => boolean;
	opFor: (value: string) => StructOp;
	/** Destroy the editor locally (no doc change, draft cleared). */
	closeLocal: () => void;
	/** A widget rebuild detached the host: release CM/listeners but retain draft. */
	destroyDetached: () => void;
	preserveDraft: (value: string) => void;
	clearDraft: () => void;
	/** The editor's own cancel path (dirty editors arm "Discard changes?"). */
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
	for (const job of jobs.filter((j) => j.value === j.e.target.original)) job.e.closeLocal();
	const changed = jobs.filter((j) => j.value !== j.e.target.original).sort((a, b) => byDocOrderDesc(a.e, b.e));
	const groups = new Map<OpenEditor["applyMany"], typeof changed>();
	for (const job of changed) {
		const group = groups.get(job.e.applyMany) ?? [];
		group.push(job);
		groups.set(job.e.applyMany, group);
	}
	const orderedGroups = [...groups].sort(([, a], [, b]) => b[0].e.blockOrder - a[0].e.blockOrder);
	for (const [applyMany, group] of orderedGroups) {
		for (const job of group) job.e.clearDraft();
		if (applyMany(group.map((j) => j.e.opFor(j.value)))) {
			for (const job of group) job.e.closeLocal();
		} else {
			for (const job of group) job.e.preserveDraft(job.value);
			new Notice("Mica: the block changed while you were editing. Your draft is still open.");
		}
	}
}

/** Widget rebuilds (mode flips, cursor overlap) can destroy an editor's DOM
 *  without unregistering it — drop entries whose region left the document. */
function sweepDetached(): void {
	for (const ed of [...openEditors]) if (!ed.region.isConnected) ed.destroyDetached();
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
			ed.clearDraft();
			if (value === ed.target.original || ed.applyOp(value)) ed.closeLocal();
			else {
				ed.preserveDraft(value);
				new Notice("Mica: the block changed while you were editing. Your draft is still open.");
			}
		} else {
			ed.closeLocal();
		}
	}
}

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

let removeGlobalListeners: (() => void) | null = null;

/** Install document listeners under the plugin lifecycle, never at module
 * import time. The disposer is idempotent and releases every live CM editor. */
export function installQuickEditGlobalListeners(): () => void {
	if (!removeGlobalListeners) {
		document.addEventListener("pointerdown", onDocPointerDown, true);
		document.addEventListener("keydown", onDocKeydown, true);
		removeGlobalListeners = () => {
			document.removeEventListener("pointerdown", onDocPointerDown, true);
			document.removeEventListener("keydown", onDocKeydown, true);
			for (const ed of [...openEditors]) ed.destroyDetached();
			removeGlobalListeners = null;
		};
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		removeGlobalListeners?.();
	};
}

/**
 * The inline quick editor: a compact CodeMirror markdown editor with a mini
 * toolbar and a PINNED action bar on top (targets never move while the editor
 * grows). Blur never commits; drafts are mirrored onto the block's UI state so
 * a widget rebuild or a mode flip reopens the editor with nothing lost.
 */
export function openQuickEdit(region: HTMLElement, ctx: RenderCtx, target: RegionTarget, initial?: string): void {
	if (region.hasClass("is-editing")) return;
	// Deferred one tick: opened from an Obsidian Menu item, the menu's hide()
	// restores focus to the OUTER editor right after onClick. If our inner
	// editor is already mounted and focused by then, that refocus parks the
	// document selection at the widget host's DOM point — CodeMirror's
	// MutationObserver maps it INSIDE the block and the whole widget flips to
	// raw source, killing this editor as it opens. Mounting after the menu
	// has fully closed leaves the final focus (and selection) with us.
	region.addClass("is-editing"); // reserve now — a double click must not stack two mounts
	window.setTimeout(() => {
		region.removeClass("is-editing");
		if (!region.isConnected) return; // the block re-rendered meanwhile
		// A native caret parked in this region (a trusted click plants one in
		// chrome even past preventDefault) would be RELOCATED by the mount's
		// DOM surgery and synced by CodeMirror as "cursor inside the block" —
		// flipping the widget to raw source. No anchor, no relocation, no flip.
		const s = window.getSelection();
		if (s?.anchorNode && region.contains(s.anchorNode)) s.removeAllRanges();
		openQuickEditNow(region, ctx, target, initial);
	}, 0);
}

function openQuickEditNow(region: HTMLElement, ctx: RenderCtx, target: RegionTarget, initial?: string): void {
	if (region.hasClass("is-editing")) return;
	region.empty();
	region.removeClass("is-editable");
	region.addClass("is-editing");

	const key = draftKey(target);
	const setDraft = (text: string | null): void => {
		if (!ctx.ui) return;
		ctx.ui.draft = text === null ? null : { key, text, expected: target.original };
	};

	// --- Action bar (TOP, fixed): Save · Cancel · spacer · tools · Expand ----
	const bar = region.createDiv({ cls: "mica-qe-bar" });
	const save = bar.createEl("button", { cls: "mod-cta mica-qe-save", text: "Save", attr: { type: "button" } });
	const cancel = bar.createEl("button", { cls: "mica-qe-cancel", text: "Cancel", attr: { type: "button" } });
	const tools = bar.createDiv({ cls: "mica-qe-tools" });
	bar.createDiv({ cls: "mica-footer-spacer" });
	const lineBtn = bar.createEl("button", {
		cls: "clickable-icon mica-qe-lines",
		attr: { type: "button", "aria-label": "Toggle line numbers", "aria-pressed": "false" },
	});
	setIcon(lineBtn, "list-ordered");

	const host = region.createDiv({ cls: "mica-qe-host" });
	if (!(ctx.editorAutosize ?? true)) host.addClass("is-fixed");

	let discardArmed = false;
	let discardTimer: number | null = null;
	const disarm = (): void => {
		if (discardTimer !== null) window.clearTimeout(discardTimer);
		discardTimer = null;
		if (!discardArmed) return;
		discardArmed = false;
		cancel.removeClass("mica-danger");
		cancel.setText("Cancel");
	};

	const shortcut = saveShortcutLabel();
	const editor = new MdEditor(host, {
		app: ctx.app,
		initial: initial ?? target.original,
		placeholder: shortcut ? `Write markdown — ${shortcut} saves, Esc cancels` : "Write markdown — Esc cancels",
		onSave: () => commit(),
		onCancel: () => requestCancel(),
		onChange: (v) => {
			disarm();
			setDraft(v === target.original ? null : v);
		},
	});

	const destroyToolbar = buildToolbar(tools, ctx.app, () => editor.view, true);
	const updateLineButton = (): void => {
		const on = editorViewPrefs().lineNumbers;
		lineBtn.setAttribute("aria-pressed", String(on));
		lineBtn.toggleClass("is-on", on);
	};
	lineBtn.addEventListener("mousedown", (event) => event.preventDefault());
	lineBtn.addEventListener("click", () => toggleViewPref("lineNumbers"));
	document.addEventListener("mica-editor-prefs-change", updateLineButton);
	updateLineButton();
	const openExpanded = (): void => {
		disarm();
		openEditors.delete(entry);
		const value = editor.getValue();
		destroyToolbar();
		actionMenu.destroy();
		document.removeEventListener("mica-editor-prefs-change", updateLineButton);
		editor.destroy();
		region.removeClass("is-editing");
		ctx.repaintRegion?.(region, target);
		openLightboxFor(ctx, target, value);
	};
	const actionMenu = mountActionMenu(
		bar,
		() => {
			const prefs = editorViewPrefs();
			return [
				{ id: "expand", label: "Open in the full editor", icon: "maximize-2", run: openExpanded },
				{
					id: "whitespace",
					label: "Show whitespace",
					icon: "pilcrow",
					checked: prefs.whitespace,
					run: () => toggleViewPref("whitespace"),
				},
				{
					id: "syntax",
					label: "Style Markdown source",
					icon: "wand-sparkles",
					checked: prefs.liveSyntax,
					run: () => toggleViewPref("liveSyntax"),
				},
			] satisfies ActionSpec[];
		},
		"mica-qe-actions",
		"Editor actions",
		ctx.app,
	);

	const closeToView = (): void => {
		disarm();
		openEditors.delete(entry);
		setDraft(null);
		destroyToolbar();
		actionMenu.destroy();
		document.removeEventListener("mica-editor-prefs-change", updateLineButton);
		editor.destroy();
		region.removeClass("is-editing");
		if (region.isConnected) ctx.repaintRegion?.(region, target);
	};
	const preserveDraft = (value: string): void => setDraft(value === target.original ? null : value);
	const destroyDetached = (): void => {
		disarm();
		openEditors.delete(entry);
		preserveDraft(editor.getValue());
		destroyToolbar();
		actionMenu.destroy();
		document.removeEventListener("mica-editor-prefs-change", updateLineButton);
		editor.destroy();
	};
	const opFor = (value: string): StructOp => ({
		op: "saveRegion",
		path: target.path,
		start: target.start,
		end: target.end,
		expected: target.original,
		text: value,
	});

	const entry: OpenEditor = {
		blockOrder: ctx.editable?.order ?? 0,
		region,
		target,
		cancel: () => requestCancel(),
		getValue: () => editor.getValue(),
		applyOp: (value) => ctx.editable?.apply(opFor(value)) ?? false,
		applyMany: ctx.editable?.applyMany ?? (() => false),
		opFor,
		closeLocal: closeToView,
		destroyDetached,
		preserveDraft,
		clearDraft: () => setDraft(null),
	};
	openEditors.add(entry);

	// One Save commits every open editor (registry semantics).
	const commit = (): void => commitAllOpen();

	const requestCancel = (): void => {
		if (actionMenu.isOpen()) {
			actionMenu.close();
			return;
		}
		if (editor.getValue() === target.original || discardArmed) {
			closeToView();
			return;
		}
		discardArmed = true;
		cancel.addClass("mica-danger");
		cancel.setText("Discard changes?");
		discardTimer = window.setTimeout(disarm, 2500);
	};

	save.addEventListener("mousedown", (e) => e.preventDefault());
	save.addEventListener("click", commit);
	cancel.addEventListener("mousedown", (e) => e.preventDefault());
	cancel.addEventListener("click", requestCancel);
}

/** The full-screen editor for a region (Expand, or Ctrl/Cmd+click). */
export function openLightboxFor(ctx: RenderCtx, target: RegionTarget, initial?: string): void {
	const key = draftKey(target);
	new EditorLightbox({
		app: ctx.app,
		title: "Edit section",
		initial: initial ?? ctx.ui?.draft?.text ?? target.original,
		sourcePath: ctx.sourcePath,
		onDraft: (v) => {
			if (ctx.ui) ctx.ui.draft = v === target.original ? null : { key, text: v, expected: target.original };
		},
		onDiscard: () => {
			if (ctx.ui?.draft?.key === key) ctx.ui.draft = null;
		},
		onSave: (value) => {
			if (value === target.original) {
				if (ctx.ui?.draft?.key === key) ctx.ui.draft = null;
				return true;
			}
			if (ctx.ui?.draft?.key === key) ctx.ui.draft = null;
			const accepted =
				ctx.editable?.apply({
					op: "saveRegion",
					path: target.path,
					start: target.start,
					end: target.end,
					expected: target.original,
					text: value,
				}) ?? false;
			if (accepted) {
				return true;
			}
			if (ctx.ui) ctx.ui.draft = { key, text: value, expected: target.original };
			new Notice("Mica: the section changed while you were editing. Your draft is still open.");
			return false;
		},
	}).open();
}
