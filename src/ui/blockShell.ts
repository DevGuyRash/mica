import { App, Component, Menu, MarkdownRenderer, Notice, setIcon, TFile } from "obsidian";
import { protectLiteralAnglePlaceholders } from "./markdownLiteral";
import type MicaPlugin from "../main";
import { parseBlock, scanBlocksView, serializeCst, type Cst, type MicaNode } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import type { Reveal, StructOp } from "../cst/ops";
import { makeDraggable, type CombineSpec, type CombineTargetElement } from "./dnd";
import { draftKey, openLightboxFor, openQuickEdit, type RegionTarget } from "./quickEdit";
import { setMicaIcon } from "../icons/setMicaIcon";
import { openCalloutEditor, openCalloutEditorFor, parseCallout } from "./calloutEditor";
import { openCodeBlockEditor, openCodeBlockEditorFor } from "./codeBlockEditor";
import { parseCodeFence } from "./codeFence";
import { classifySection, convertSection, type SectionKind } from "./sectionFormat";
import {
	dedentNested,
	findNestedSections,
	materializeQuotedSection,
	requoteOnce,
	spliceLines,
	spliceQuotedSection,
	type NestedCallout,
	type NestedCodeBlock,
} from "./nestedCallouts";
import { calloutCatalog } from "./calloutCatalog";
import { EditorLightbox } from "./lightbox";
import { VersionsModal } from "./versionsModal";
import { DEFAULT_COPY_OPTIONS, type CopyOptions, type CopyTarget } from "./copyPayload";
import { writeClipboardProjection } from "./clipboard";
import { resolveExactCopySelection, type CopySelectionRef } from "./copySelection";
import { blockNameValidationError, displayBlockName, type BlockNamePresentation } from "../identity/blockLabel";
import { populateActionMenu, showActionMenuAtEvent, type ActionSpec } from "./actionMenu";
import { filterSectionActions, type SectionActionPreferenceId } from "./sectionActionPrefs";
import { mountResponsiveActionStrip } from "./responsiveActionStrip";
import { openIconPicker } from "./iconPicker";
import { mountLongBlockObserver, scrollLongBlock, type LongBlockPlacement } from "./longBlockControls";
import type { WorkingCopyProvider } from "./versionsModal";
import { revertBlockToHead, saveBlockVersion } from "./versionActions";
import {
	DEFAULT_DOCK_ACTION_LAYOUT,
	DOCK_ACTION_OPTIONS,
	type DockActionId,
	type DockCopyTargetMode,
} from "./dockConfig";
import type { ScopeLocator } from "./versionScopeCore";
import {
	compactDockTargetLabel,
	copyTargetForScope,
	dockCopyTargetDescription,
	DockTargetController,
	type DockDraftOverlay,
} from "./dockScope";
import { buildDockRuntimeSource, sourceWithDraft } from "./dockScopeRuntime";
import { DockScopePicker } from "./dockScopePicker";

/** The hooks a rendered block uses to mutate itself (Live Preview only). */
export interface EditHooks {
	/** Original document position used only to order ID-less block batches from
	 * bottom to top; every individual batch still re-scans before dispatch. */
	order: number;
	/** True only when the live document accepted and dispatched the op. */
	apply: (op: StructOp) => boolean;
	/** Apply a batch against one fresh CST and dispatch once. A rejected member
	 * rejects the whole batch, which keeps multi-editor Save all-or-nothing. */
	applyMany: (ops: readonly StructOp[]) => boolean;
	/** Replace the whole block content (undo toasts, whole-block edits). */
	replaceAll: (expected: string, content: string) => boolean;
	/** Write / remove a fence-header attribute (name, accent, density, …). */
	setAttr: (key: string, value: string | null) => void;
}

/** Everything the footer needs to show version state and open history. */
export interface ChipInfo {
	plugin: MicaPlugin;
	file: TFile;
	blockId: string;
	content: string;
	workingCopy?: WorkingCopyProvider;
	recordDocuments?: (before: string, after: string, blockIds: readonly string[]) => void;
	acknowledgeExactState?: (document: string, blockIds: readonly string[], state: "done" | "undone") => boolean;
}

/**
 * UI state that survives the widget being rebuilt after every edit: active tab
 * per group, a one-shot focus target, the in-progress editor draft, and the
 * collapsed flag. Keyed by block id on the plugin, so it also survives
 * reading ⇄ editing mode flips.
 */
export interface BlockUi {
	active: Map<string, number>;
	reveal: Reveal | null;
	draft: {
		key: string;
		text: string;
		expected: string;
		path?: number[];
		start?: number;
		end?: number;
	} | null;
	/** Session-only exact locator selected from the traveling dock. */
	dockPinnedScope?: ScopeLocator;
	/** Provisional tab-title edit; survives a CodeMirror widget replacement
	 * without touching source or dirty state. */
	tabRename?: {
		path: string;
		index: number;
		display: string;
		value: string;
	};
	collapsed: boolean;
	/** Keep the appearance popover open across attribute-driven widget rebuilds. */
	appearanceOpen: boolean;
	/** Current popover cleanup, including document listeners, across widget replacement. */
	appearanceCleanup?: (endSession?: boolean) => void;
	/** Folded sections/groups (keys: `r:<path>:<start>` and `n:<path>`). */
	folded: Set<string>;
	/** Persist the fold set (folds survive restarts). Set by the host. */
	persistFolds?: () => void;
}

export interface RenderCtx {
	app: App;
	sourcePath: string;
	component: Component;
	editable?: EditHooks;
	chip?: ChipInfo;
	/** Live Preview only: grow the inline editor with content (default true). */
	editorAutosize?: boolean;
	ui?: BlockUi;
	/** Fence-header attrs (name, accent, density, tabstyle, radius, …). */
	blockAttrs?: Record<string, string>;
	/** Presentation-only fallback for a missing `name=` fence attribute. */
	blockNamePresentation?: BlockNamePresentation;
	/** Header visibility: hover (default) / always / never. */
	headerMode?: "hover" | "always" | "never";
	/** Read the current clipboard preferences when a copy button is pressed. */
	copyOptions?: () => CopyOptions;
	/** Secondary rendered-entity actions either promote when they fit or remain menu-only. */
	entityActionLayout?: "responsive" | "menu-only";
	/** Tabs stay menu-only; this controls whether their visual trigger appears on hover/focus. */
	showTabActionMenuOnHover?: boolean;
	/** Reachability treatment for exceptionally tall rendered blocks. */
	longBlockControls?: "contextual" | "jumps-only" | "off";
	dockCopyTargetMode?: DockCopyTargetMode;
	dockActionLayout?: readonly DockActionId[];
	/** Hidden only from semantic section chrome; block, tab, grid, cell, and editor actions are unaffected. */
	hiddenSectionActions?: ReadonlySet<SectionActionPreferenceId>;
	/** The block's current content — captured before destructive ops for Undo. */
	preImage?: () => string;
	/** Session-only, stable-id edit history owned by the containing editor. */
	editHistory?: {
		canUndo: () => boolean;
		canRedo: () => boolean;
		undo: () => boolean;
		redo: () => boolean;
	};
	/** Mark widget-chrome pointer focus as ineligible to reveal raw source. */
	suppressSourceReveal?: () => void;
	/** Internal: repaint one region back to view mode after a cancel. */
	repaintRegion?: (region: HTMLElement, target: RegionTarget) => void;
	/** Internal: repaint the whole block without a doc change (folds). */
	rerenderBlock?: () => void;
	/** Internal: the block's root children — ancestry checks for unified
	 * gap menus ("Below the tabs group…"). Set by renderCst. */
	rootNodes?: MicaNode[];
	/** Internal owner/pass split: repainting unloads every observer/listener
	 * registered by the previous render before installing the next pass. */
	renderPassOwner?: Component;
	renderPass?: Component;
	/** Read-only history inspection: structural scopes remain navigable while
	 * edit/copy/fold/drag chrome and external navigation stay suppressed. */
	inspection?: {
		selectedKey?: string;
		selectedKeys?: readonly string[];
		onSelect: (key: string, modifiers: { toggle: boolean; range: boolean; additive: boolean }) => void;
	};
	/** Internal per-render indexes. */
	combineTargets?: CombineTargetElement[];
	combineNeighbors?: WeakMap<CombineTargetElement, { previous?: CombineSpec; next?: CombineSpec; index: number }>;
	/** Visible combinable regions in document order, rebuilt with the index.
	 * Menu construction reads this instead of rescanning the document. */
	combineOrder?: CombineSpec[];
	rebuildCombineIndex?: () => void;
	buildingCombineIndex?: boolean;
	inspectionFocusableKeys?: Set<string>;
	openMenus?: Set<Menu>;
}

type Container = Extract<MicaNode, { kind: "container" }>;
type Leaf = Extract<MicaNode, { kind: "leaf" }>;

let closeActiveNavigator: (() => void) | null = null;

/**
 * A square icon button (Lucide via setIcon) with an accessible label.
 * Carries Obsidian's `clickable-icon` class so themes apply their icon-button
 * treatment (and skip their heavy text-button skin) — never fight the theme.
 */
function iconButton(parent: HTMLElement, cls: string, icon: string, label: string): HTMLButtonElement {
	const b = parent.createEl("button", {
		cls: `clickable-icon ${cls}`,
		attr: { type: "button", "aria-label": label },
	});
	setIcon(b, icon);
	return b;
}

interface CopyControl {
	kind: "block" | "tabs" | "tab" | "grid" | "cell" | "text" | "callout" | "code" | "nested-callout" | "nested-code";
	label: string;
	notice: string;
	path?: readonly number[];
	target: CopyTarget | (() => CopyTarget | null);
	selection?: CopySelectionRef;
}

function copyTarget(ctx: RenderCtx, control: CopyControl): void {
	const target = typeof control.target === "function" ? control.target() : control.target;
	if (!target) {
		new Notice("Mica: this item changed before it could be copied. Open its menu and try again.");
		return;
	}
	writeClipboardProjection(target, ctx.copyOptions?.() ?? DEFAULT_COPY_OPTIONS, control.notice);
}

function copyAction(ctx: RenderCtx, control: CopyControl, separatorBefore = false): ActionSpec {
	return {
		id: `copy-${control.kind}`,
		label: control.label,
		icon: "copy",
		separatorBefore,
		directPriority: 0,
		run: () => copyTarget(ctx, control),
	};
}

/** One whole-block selection contract shared by the header action and the
 * traveling dock. Live Preview reparses the current in-memory body at click
 * time; Reading View uses the immutable CST it rendered. */
function blockCopyControl(cst: Cst, ctx: RenderCtx): CopyControl {
	return {
		kind: "block",
		label: "Copy block contents",
		notice: "Block copied.",
		target: () => {
			const current = ctx.preImage?.();
			if (current === undefined) return { nodes: cst.children };
			try {
				return { nodes: parseBlock(current).children };
			} catch {
				return null;
			}
		},
	};
}

function presentEntityActions(actions: readonly ActionSpec[]): ActionSpec[] {
	return actions.map((action) => {
		if (action.directPriority !== undefined || action.overflowOnly || action.pinned) return action;
		const id = action.id;
		if (!action.icon) return { ...action, overflowOnly: true };
		if (["edit", "edit-source", "lightbox", "fields", "rename"].includes(id))
			return { ...action, directPriority: 1 };
		if (["collapse", "fold", "icon", "duplicate"].includes(id)) return { ...action, directPriority: 2 };
		if (id === "delete" || id === "clear") return { ...action, directPriority: 4 };
		return { ...action, directPriority: 3 };
	});
}

function entityWidthSource(parent: HTMLElement): HTMLElement {
	if (parent.hasClass("mica-tab-chip") || parent.hasClass("mica-fold-bar")) return parent;
	return parent.parentElement ?? parent;
}

function entityMenu(
	parent: HTMLElement,
	ctx: RenderCtx,
	actions: () => readonly ActionSpec[],
	label: string,
	cls = "mica-minitool",
	options?: { menuOnly?: boolean; className?: string },
) {
	if (ctx.inspection) return undefined;
	const presented = () => presentEntityActions(actions());
	const source = entityWidthSource(parent);
	const pinnedSiblings = Array.from(parent.children).filter(
		(child): child is HTMLElement =>
			child instanceof HTMLElement && !child.hasClass("mica-footer-spacer") && !child.hasClass("mica-nav-spacer"),
	);
	const tabBudget = parent.hasClass("mica-tab-chip") ? Math.max(0, parent.clientWidth - 48) : null;
	const mounted = mountResponsiveActionStrip(parent, presented, {
		app: ctx.app,
		source,
		label,
		className: `mica-entity-strip ${options?.className ?? ""}`.trim(),
		buttonClass: cls,
		menuClass: `${cls} mica-entity-menu`,
		menuOnly: options?.menuOnly ?? ctx.entityActionLayout === "menu-only",
		reservedWidth: () =>
			tabBudget === null
				? pinnedSiblings.reduce((width, element) => width + element.offsetWidth, 8)
				: Math.max(0, source.clientWidth - tabBudget),
	});
	ctx.component.register(mounted.destroy);
	return mounted;
}

function ownMenu(ctx: RenderCtx, menu: Menu): Menu {
	ctx.openMenus?.add(menu);
	menu.onHide(() => ctx.openMenus?.delete(menu));
	return menu;
}

const pathKey = (path: number[]): string => path.join(",");
const samePath = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const prefixOf = (parent: number[], child: number[]): boolean =>
	child.length === parent.length + 1 && parent.every((x, i) => x === child[i]);

/** A tab occupies two elements — its chip and its panel — under one scope key.
 * Both take the selected outline, but only one may carry the ordinal badge, or
 * a single selection appears to be two. */
function markInspectable(el: HTMLElement, ctx: RenderCtx, key: string, ordinalBadge = true): void {
	el.dataset.micaDockScope = key;
	if (!ctx.inspection) return;
	el.dataset.micaInspectKey = key;
	const selectedKeys = ctx.inspection.selectedKeys ?? [ctx.inspection.selectedKey ?? "block:"];
	const selectedIndex = selectedKeys.indexOf(key);
	const selected = selectedIndex >= 0;
	el.toggleClass("is-inspect-selected", selected);
	if (selected) {
		el.setAttribute("aria-selected", "true");
		if (ordinalBadge) el.dataset.micaInspectOrder = String(selectedIndex + 1);
		else delete el.dataset.micaInspectOrder;
	} else {
		el.setAttribute("aria-selected", "false");
		delete el.dataset.micaInspectOrder;
	}
	if (!el.hasClass("mica-tab-chip") && !ctx.inspectionFocusableKeys?.has(key)) {
		ctx.inspectionFocusableKeys?.add(key);
		el.tabIndex = 0;
		el.setAttribute("role", "treeitem");
		el.setAttribute("aria-label", `Selectable ${key.split(":", 1)[0] || "block"} scope`);
	}
}

function selectInspectionScope(
	scope: HTMLElement,
	ctx: RenderCtx,
	event: Pick<MouseEvent | KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): void {
	ctx.inspection?.onSelect(scope.dataset.micaInspectKey ?? "block:", {
		toggle: event.ctrlKey || event.metaKey,
		range: event.shiftKey,
		additive: event.shiftKey && (event.ctrlKey || event.metaKey),
	});
}

/** `"A {icon=rocket}"` → `["A", "icon=rocket"]`. */
export function splitTitleAttrs(title: string): [string, string] {
	const t = title.trimEnd();
	if (t.endsWith("}")) {
		const open = t.lastIndexOf("{");
		if (open >= 0) return [t.slice(0, open).trim(), t.slice(open + 1, -1).trim()];
	}
	return [t.trim(), ""];
}

function titleAttr(title: string, key: string): string | null {
	const [, attrs] = splitTitleAttrs(title);
	for (const tok of attrs.split(/\s+/)) {
		const eq = tok.indexOf("=");
		if (eq > 0 && tok.slice(0, eq) === key) return tok.slice(eq + 1);
	}
	return null;
}

/** Consume a one-shot region-edit reveal if it targets `path`. */
function takeRegionReveal(ctx: RenderCtx, path: number[]): boolean {
	const r = ctx.ui?.reveal;
	if (r && r.kind === "region-edit" && samePath(r.path, path)) {
		ctx.ui!.reveal = null;
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render a parsed block into `el`. Shared by reading view and Live Preview. */
export function renderCst(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	if (!ctx.renderPassOwner) {
		const pass = new Component();
		ctx.component.addChild(pass);
		renderCst(cst, el, { ...ctx, component: pass, renderPassOwner: ctx.component, renderPass: pass });
		return;
	}
	el.addClass("mica");
	ctx.openMenus = new Set();
	ctx.component.register(() => {
		for (const menu of ctx.openMenus ?? []) menu.hide();
		ctx.openMenus?.clear();
	});
	el.setAttribute("data-mica-mode", ctx.editable ? "edit" : "read");
	if (ctx.inspection) {
		ctx.inspectionFocusableKeys = new Set();
		el.addClass("mica-inspection-render");
		el.setAttribute("role", "tree");
		el.setAttribute("aria-multiselectable", "true");
		markInspectable(el, ctx, "block:");
		let hovered: HTMLElement | null = null;
		el.addEventListener("pointerover", (event) => {
			const next = (event.target as HTMLElement).closest<HTMLElement>("[data-mica-inspect-key]");
			if (!next || !el.contains(next) || next === hovered) return;
			hovered?.removeClass("is-inspect-hover");
			hovered = next;
			hovered.addClass("is-inspect-hover");
		});
		el.addEventListener("pointerleave", () => {
			hovered?.removeClass("is-inspect-hover");
			hovered = null;
		});
		el.addEventListener("click", (event) => {
			const target = event.target as HTMLElement;
			if (target.closest("a, .internal-link")) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			const scope = target.closest<HTMLElement>("[data-mica-inspect-key]");
			if (!scope || !el.contains(scope)) return;
			selectInspectionScope(scope, ctx, event);
		});
		el.addEventListener("keydown", (event) => {
			const target = event.target as HTMLElement;
			const scope = target.closest<HTMLElement>("[data-mica-inspect-key]");
			if (!scope || !el.contains(scope)) return;
			if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
				const items = Array.from(el.querySelectorAll<HTMLElement>('[data-mica-inspect-key][tabindex="0"]'));
				const current = items.indexOf(scope);
				const next =
					event.key === "Home"
						? items[0]
						: event.key === "End"
							? items.at(-1)
							: items[
									Math.max(
										0,
										Math.min(items.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)),
									)
								];
				if (!next) return;
				event.preventDefault();
				next.focus();
				if (event.shiftKey) selectInspectionScope(next, ctx, event);
				return;
			}
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			selectInspectionScope(scope, ctx, event);
		});
		const suppressLinks = (): void => {
			for (const link of el.querySelectorAll<HTMLElement>("a, .internal-link")) {
				link.tabIndex = -1;
				link.setAttribute("aria-disabled", "true");
			}
		};
		const observer = new MutationObserver(suppressLinks);
		observer.observe(el, { childList: true, subtree: true });
		ctx.component.register(() => observer.disconnect());
		suppressLinks();
	}
	applyBlockAttrs(el, ctx.blockAttrs ?? {});

	// A repaint closure so collapse and cancels can redraw without a doc change.
	ctx.repaintRegion = (region, target) => paintRegionView(region, ctx, target);
	ctx.rerenderBlock = () => rerender(cst, el, ctx);
	ctx.rootNodes = cst.children;

	// Keep widget-internal pointer events away from CodeMirror: a click inside
	// the block must never move the note's caret (that is what caused the
	// "everything flips to raw source" surprise). BUBBLE phase, so the block's
	// own controls (drag grips, chips, editors) still receive their events —
	// stopping here only prevents the event from reaching CodeMirror above.
	// Attached once — collapse/appearance repaints reuse the same root element.
	if (ctx.editable && !el.hasAttribute("data-mica-guarded")) {
		el.setAttribute("data-mica-guarded", "1");
		for (const type of ["pointerdown", "mousedown", "click"] as const) {
			el.addEventListener(type, (e) => {
				const t = e.target as HTMLElement;
				if (t.closest("a, .internal-link")) return;
				// Our stopPropagation starves Obsidian's document-level
				// menu-close listener: menus opened from the widget would
				// linger (and stack) until Esc. Close them ourselves. The
				// synthetic events skip "pointerdown" so the click-outside
				// editor handler (pointerdown-only) never miscounts a
				// widget-internal click as outside.
				if (type === "pointerdown" && document.querySelector("body > .menu")) {
					for (const evt of ["mousedown", "click"] as const) {
						document.body.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
					}
				}
				e.stopPropagation();
				// A TRUSTED mousedown on text-less chrome (empty regions, cell
				// padding, bars, strips) lets the browser place the native
				// caret at the nearest EDITABLE position — which is outside
				// this contenteditable=false widget, i.e. in the outer
				// document INSIDE the block's range: the block then flips to
				// raw source. stopPropagation cannot stop a native default
				// action — only preventDefault can. Allow the default only
				// where it means something: rendered prose (text selection)
				// and real inputs/editors (focus).
				const markdownSurface = t.closest<HTMLElement>(".mica-md");
				const renderedProse = Boolean(
					markdownSurface?.textContent?.trim() && !markdownSurface.querySelector(".mica-ghost"),
				);
				const focusableEditor = Boolean(t.closest('input, textarea, [contenteditable="true"], .mica-mdeditor'));
				if ((type === "mousedown" || type === "pointerdown") && !renderedProse && !focusableEditor) {
					ctx.suppressSourceReveal?.();
					e.preventDefault();
					// Belt AND suspenders: some trusted-input paths (WebDriver
					// focus steps, browser quirks) plant the caret in chrome
					// regardless. A later DOM mutation would relocate it and
					// CodeMirror would sync it as an in-block cursor. Evict it.
					queueMicrotask(() => {
						const s = window.getSelection();
						if (s?.anchorNode && el.contains(s.anchorNode)) s.removeAllRanges();
					});
				}
			});
		}
	}

	const header = renderHeader(cst, el, ctx);
	if (ctx.ui?.collapsed) {
		el.addClass("is-collapsed");
		if (ctx.chip) renderFooter(el, ctx, ctx.chip);
		return;
	}

	const body = el.createDiv({ cls: "mica-block-body" });
	ctx.combineTargets = [];
	ctx.combineNeighbors = new WeakMap();
	ctx.rebuildCombineIndex = () => {
		const visible = (ctx.combineTargets ?? []).filter(
			(target) => !target.closest(".mica-tab-panel:not(.is-active), .mica.is-collapsed"),
		);
		const neighbors = new WeakMap<
			CombineTargetElement,
			{ previous?: CombineSpec; next?: CombineSpec; index: number }
		>();
		const order: CombineSpec[] = [];
		for (let index = 0; index < visible.length; index++) {
			neighbors.set(visible[index], {
				previous: visible[index - 1]?.micaCombine,
				next: visible[index + 1]?.micaCombine,
				index,
			});
			const spec = visible[index].micaCombine;
			if (spec) order.push(spec);
		}
		ctx.combineNeighbors = neighbors;
		ctx.combineOrder = order;
	};
	markGroupContainer(body, [], cst.children.length);
	const rootInsert = !cst.children.some((c) => c.kind === "container");
	const autoOpen = takeRegionReveal(ctx, []);
	ctx.buildingCombineIndex = true;
	renderNodes(cst.children, body, ctx, [], { insert: rootInsert, autoOpen });
	ctx.buildingCombineIndex = false;
	ctx.rebuildCombineIndex();
	if (ctx.chip) {
		const footer = renderFooter(el, ctx, ctx.chip);
		if (!ctx.inspection) mountLongBlockStatus(cst, el, header, footer, ctx);
	}
}

/** Per-block appearance: fence attrs → local CSS vars / data attributes. */
function applyBlockAttrs(el: HTMLElement, attrs: Record<string, string>): void {
	el.style.removeProperty("--mica-accent");
	el.style.removeProperty("--mica-radius");
	el.removeAttribute("data-mica-density");
	el.removeAttribute("data-mica-tabstyle");
	el.removeAttribute("data-mica-outline");
	if (attrs["accent"]) el.style.setProperty("--mica-accent", attrs["accent"]);
	if (attrs["radius"]) el.style.setProperty("--mica-radius", `${Number(attrs["radius"]) || 0}px`);
	if (attrs["density"]) el.setAttribute("data-mica-density", attrs["density"]);
	if (attrs["tabstyle"]) el.setAttribute("data-mica-tabstyle", attrs["tabstyle"]);
	// Structural outlines: absent attr = follow the global setting (body class).
	if (attrs["outline"]) el.setAttribute("data-mica-outline", attrs["outline"]);
	el.setAttribute("data-mica-wrap", attrs["wrap"] === "off" ? "off" : "on");
}

function markGroupContainer(el: HTMLElement, path: number[], len: number): void {
	el.setAttribute("data-mica-container", "group");
	el.setAttribute("data-path", path.join("."));
	el.setAttribute("data-len", String(len));
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(cst: Cst, el: HTMLElement, ctx: RenderCtx): HTMLElement | null {
	const mode = ctx.headerMode ?? "hover";
	if (mode === "never" && !ctx.ui?.collapsed) return null;
	const head = el.createDiv({ cls: `mica-head ${mode === "always" || ctx.ui?.collapsed ? "is-pinned" : ""}` });

	// Name (click to rename in LP).
	const name = ctx.blockAttrs?.["name"] ?? "";
	const presentation = ctx.blockNamePresentation ?? { noteBasename: "", unnamedOrdinal: 1 };
	const fallbackName = displayBlockName(null, presentation);
	const displayName = displayBlockName(name, presentation);
	const nameBtn = head.createEl("button", {
		cls: `mica-head-name ${name.trim() ? "" : "is-unnamed"}`,
		text: displayName,
		attr: { type: "button", "aria-label": ctx.editable ? "Rename block" : "Block name" },
	});
	if (ctx.editable) {
		nameBtn.addEventListener("click", () => {
			const input = head.createEl("input", {
				cls: "mica-rename",
				attr: { type: "text", placeholder: fallbackName },
			});
			head.insertBefore(input, nameBtn);
			nameBtn.style.display = "none";
			input.value = name;
			input.focus();
			input.select();
			let done = false;
			const commit = (): void => {
				if (done) return;
				const error = blockNameValidationError(input.value);
				if (error) {
					input.setCustomValidity(error);
					input.reportValidity();
					new Notice(`Mica: ${error}`);
					return;
				}
				input.setCustomValidity("");
				done = true;
				const v = input.value.trim();
				if (v !== name) ctx.editable?.setAttr("name", v || null);
				else {
					input.remove();
					nameBtn.style.display = "";
				}
			};
			input.addEventListener("input", () => input.setCustomValidity(""));
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") commit();
				else if (e.key === "Escape") {
					done = true;
					input.remove();
					nameBtn.style.display = "";
				}
			});
			input.addEventListener("blur", commit);
		});
	}
	// The fold control is anchored immediately after the stable block name.
	// Content height, scrollbars, summaries, and responsive actions can change
	// across the fold, but none of them can move this slot under the pointer.
	if (ctx.ui) {
		const collapse = iconButton(
			head,
			"mica-head-btn mica-collapse-anchor",
			ctx.ui.collapsed ? "chevron-right" : "chevron-down",
			ctx.ui.collapsed ? "Expand block" : "Collapse block",
		);
		collapse.addEventListener("click", () => {
			ctx.ui!.collapsed = !ctx.ui!.collapsed;
			rerender(cst, el, ctx);
		});
	}

	if (ctx.ui?.collapsed) {
		const tabs = countTabs(cst.children);
		head.createSpan({ cls: "mica-head-summary", text: tabs ? `${tabs} tab${tabs === 1 ? "" : "s"}` : "collapsed" });
	}

	head.createDiv({ cls: "mica-footer-spacer" });
	head.createDiv({ cls: "mica-long-head-slot" });
	// Mode glyph: can this block be edited right here?
	const modeIco = head.createSpan({
		cls: "mica-head-mode",
		attr: { "aria-label": ctx.editable ? "Editable (Live Preview)" : "Read-only view" },
	});
	setIcon(modeIco, ctx.editable ? "pencil" : "book-open");

	entityMenu(
		head,
		ctx,
		() => {
			const actions: ActionSpec[] = [];
			if (ctx.editable) {
				const wrapped = (ctx.blockAttrs?.["wrap"] ?? "on") !== "off";
				actions.push(
					{
						id: "wrap",
						label: wrapped ? "Wrap long lines" : "Scroll long lines",
						icon: wrapped ? "wrap-text" : "arrow-right-from-line",
						checked: wrapped,
						run: () => ctx.editable?.setAttr("wrap", wrapped ? "off" : null),
					},
					{
						id: "edit-source",
						label: "Edit block source",
						icon: "file-code",
						run: () => {
							new EditorLightbox({
								app: ctx.app,
								title: ctx.blockAttrs?.["name"]
									? `Edit “${ctx.blockAttrs["name"]}”`
									: "Edit block source",
								initial: serializeCst(cst),
								sourcePath: ctx.sourcePath,
								onSave: (value) => {
									if (!ctx.editable?.replaceAll(serializeCst(cst), value)) {
										new Notice(
											"Mica: the block changed while the editor was open. Your edit was not applied.",
										);
										return false;
									}
									return true;
								},
							}).open();
						},
					},
					{
						id: "appearance",
						label: "Block appearance…",
						icon: "palette",
						run: () => openAppearance(el, ctx),
					},
				);
			}
			actions.push(copyAction(ctx, blockCopyControl(cst, ctx), Boolean(actions.length)), {
				id: "navigator",
				label: "Block navigator",
				icon: "list-tree",
				run: () => openNavigator(cst, el, ctx),
			});
			if (ctx.chip) {
				const chip = ctx.chip;
				if (!chip.plugin.settings.showVersionChip)
					actions.push({
						id: "history",
						label: "Version history…",
						icon: "history",
						run: () => new VersionsModal(chip.plugin, chip.file, chip.blockId).open(),
					});
			}
			return actions;
		},
		"Block actions",
		"mica-head-btn",
	);
	if (ctx.ui?.appearanceOpen) {
		let frame: number | null = null;
		let attempts = 0;
		const resume = (): void => {
			frame = null;
			if (!ctx.ui?.appearanceOpen) return;
			// Obsidian may hold a freshly rebuilt CodeMirror widget off-DOM for
			// several frames while it reconciles decorations. Keep the session
			// alive for a bounded two-second window instead of briefly flashing
			// the controls back much later—or losing them under load.
			if (!el.isConnected && attempts < 120) {
				attempts++;
				frame = window.requestAnimationFrame(resume);
				return;
			}
			if (el.isConnected && !el.querySelector(".mica-appearance")) openAppearance(el, ctx, true);
		};
		frame = window.requestAnimationFrame(resume);
		ctx.component.register(() => {
			if (frame !== null) window.cancelAnimationFrame(frame);
		});
	}
	return head;
}

function countTabs(nodes: MicaNode[]): number {
	let n = 0;
	for (const c of nodes) {
		if (c.kind === "container") {
			if (c.name === "tab") n++;
			n += countTabs(c.children);
		}
	}
	return n;
}

/** Full re-render of the block into the same element (collapse, appearance). */
const regionFoldKey = (path: number[], start: number): string => `r:${path.join(",")}:${start}`;
const nodeFoldKey = (path: number[]): string => `n:${path.join(",")}`;
const foldKeyForRegion = (target: RegionTarget): string =>
	target.logical ? nodeFoldKey(target.logical.path) : regionFoldKey(target.path, target.start);

function toggleFold(ctx: RenderCtx, key: string): void {
	if (!ctx.ui) return;
	if (ctx.ui.folded.has(key)) ctx.ui.folded.delete(key);
	else ctx.ui.folded.add(key);
	ctx.ui.persistFolds?.();
	ctx.rerenderBlock?.();
}

/** A folded group/section renders as one slim, expandable bar. */
function renderFoldBar(
	host: HTMLElement,
	ctx: RenderCtx,
	key: string,
	icon: string,
	summary: string,
	drag?: {
		path: number[];
		region?: { start: number; end: number };
		combine?: CombineSpec;
		itemEl: HTMLElement;
		text?: string;
		copy?: CopyControl;
		unfoldLabel?: string;
	},
): void {
	host.addClass("is-folded");
	const bar = host.createDiv({ cls: "mica-fold-bar" });
	const kindIco = bar.createSpan({ cls: "mica-fold-kind" });
	setIcon(kindIco, icon);
	bar.createSpan({ cls: "mica-fold-text", text: summary });
	bar.setAttribute("aria-label", "Unfold");
	bar.setAttribute("role", "button");
	bar.setAttribute("aria-expanded", "false");
	bar.tabIndex = 0;
	// Mobile emulation and hybrid devices can report a coarse pointer while
	// still delivering real mouse/trackpad hover. Track pointer presence
	// explicitly so the drag affordance neither stays permanently visible nor
	// becomes unreachable when the `(hover: hover)` media query is unavailable.
	const revealPointerActions = (): void => bar.addClass("is-pointer-over");
	const hidePointerActions = (): void => bar.removeClass("is-pointer-over");
	bar.addEventListener("pointerenter", revealPointerActions);
	bar.addEventListener("pointerleave", hidePointerActions);
	// WebDriver's mobile emulation dispatches mouse hover without matching the
	// CSS hover capability; hybrid laptops can behave the same way.
	bar.addEventListener("mouseenter", revealPointerActions);
	bar.addEventListener("mouseleave", hidePointerActions);
	bar.addEventListener("click", (e) => {
		e.stopPropagation();
		toggleFold(ctx, key);
	});
	bar.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		if ((event.target as HTMLElement).closest("button") && event.target !== bar) return;
		event.preventDefault();
		toggleFold(ctx, key);
	});
	if (drag?.copy || drag) {
		bar.createDiv({ cls: "mica-footer-spacer" });
	}
	if (ctx.editable && drag) {
		const grip = iconButton(bar, "mica-region-grip mica-fold-grip", "grip-vertical", "Drag to move");
		grip.addEventListener("click", (e) => e.stopPropagation());
		makeDraggable(
			grip,
			drag.region
				? { kind: "region", fromPath: drag.path, region: drag.region, combine: drag.combine, text: drag.text }
				: { kind: "group", fromPath: drag.path, combine: drag.combine, text: drag.text },
			drag.path,
			(op) => applyDragOp(ctx, op),
			drag.itemEl,
		);
	}
	if (drag) {
		entityMenu(
			bar,
			ctx,
			() => {
				const actions: ActionSpec[] = [];
				if (drag.copy) actions.push(copyAction(ctx, drag.copy));
				actions.push({
					id: "unfold",
					label: drag.unfoldLabel ?? "Unfold this item",
					icon: "chevrons-up-down",
					pinned: true,
					run: () => toggleFold(ctx, key),
				});
				if (ctx.editable) {
					actions.push({
						id: "delete",
						label: "Delete folded item",
						icon: "trash-2",
						danger: true,
						separatorBefore: true,
						run: () =>
							deleteWithUndo(
								ctx,
								drag.region
									? {
											op: "saveRegion",
											path: drag.path,
											start: drag.region.start,
											end: drag.region.end,
											expected: drag.text ?? "",
											text: "",
										}
									: { op: "deleteNode", path: drag.path },
								"Folded item deleted",
							),
					});
				}
				return actions;
			},
			"Folded item actions",
		);
	}
}

/** The one-line summary a folded thing shows. */
function foldSummary(text: string): string {
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t) return t.length > 64 ? `${t.slice(0, 64)}…` : t;
	}
	return "(empty)";
}

function isPlainMarkdown(text: string): boolean {
	return Boolean(text.trim()) && !parseCallout(text) && !parseCodeFence(text);
}

/** UI-side promise filter for the reducer's deliberately narrow compatibility
 * contract. The shared core repeats every check and remains authoritative. */
function combineSpecFor(target: RegionTarget): CombineSpec | null {
	if (!target.logical) {
		return isPlainMarkdown(target.original)
			? {
					path: [...target.path],
					start: target.start,
					end: target.end,
					expected: target.original,
					key: "markdown",
				}
			: null;
	}
	const node = target.logical.node;
	if (
		node.kind !== "container" ||
		node.name !== "section" ||
		node.children.some(
			(child) =>
				child.kind !== "leaf" || child.is_code || (Boolean(child.text.trim()) && !isPlainMarkdown(child.text)),
		)
	)
		return null;
	const index = target.logical.path[target.logical.path.length - 1];
	if (index === undefined) return null;
	return {
		path: target.logical.path.slice(0, -1),
		start: index,
		end: index + 1,
		expected: target.logical.source,
		key: "markdown",
	};
}

function applyDragOp(ctx: RenderCtx, op: StructOp): boolean | void {
	return op.op === "combineRegions" ? applyWithUndo(ctx, op, "Sections combined") : ctx.editable?.apply(op);
}

function exactNodeCopy(ctx: RenderCtx, path: readonly number[], expected: MicaNode): () => CopyTarget | null {
	const selection: CopySelectionRef = {
		blockId: ctx.chip?.blockId ?? null,
		path: [...path],
		expectedKind: expected.kind,
		expectedName: expected.kind === "container" ? expected.name : null,
		expectedSource: serializeCst({ children: [expected] }),
	};
	return () => {
		const current = resolveExactCopySelection(ctx.rootNodes ?? [], selection);
		return current ? { nodes: [current] } : null;
	};
}

function regionCopyControl(target: RegionTarget, ctx?: RenderCtx): CopyControl {
	if (target.logical) {
		const expectedSource = serializeCst({ children: [target.logical.node] });
		return {
			kind: "text",
			label: "Copy combined section",
			notice: "Combined section copied.",
			path: target.logical.path,
			target: ctx
				? exactNodeCopy(ctx, target.logical.path, target.logical.node)
				: { nodes: [target.logical.node] },
			selection: {
				blockId: ctx?.chip?.blockId ?? null,
				path: [...target.logical.path],
				expectedKind: target.logical.node.kind,
				expectedName: target.logical.node.kind === "container" ? target.logical.node.name : null,
				expectedSource,
			},
		};
	}
	const isCallout = Boolean(parseCallout(target.original));
	const isCode = Boolean(parseCodeFence(target.original));
	const kind = isCallout ? "callout" : isCode ? "code" : "text";
	return {
		kind,
		label: kind === "callout" ? "Copy callout" : kind === "code" ? "Copy code block" : "Copy text section",
		notice: kind === "callout" ? "Callout copied." : kind === "code" ? "Code block copied." : "Section copied.",
		path: [...target.path, target.start],
		target: { text: target.original },
	};
}

function rerender(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	if (ctx.renderPass && ctx.renderPassOwner) ctx.renderPassOwner.removeChild(ctx.renderPass);
	el.empty();
	el.removeClass("is-collapsed");
	renderCst(cst, el, {
		...ctx,
		component: ctx.renderPassOwner ?? ctx.component,
		renderPassOwner: undefined,
		renderPass: undefined,
	});
}

/** The tree popover: jump to any tab/cell; shows per-tab word counts. */
interface NavRow {
	kind: "container" | "region";
	path: number[];
	parentPath: number[];
	/** CST index within the parent (containers: own idx; regions: start). */
	index: number;
	/** Regions: one past the unit's last child index. */
	end?: number;
	/** The parent's child-list length (for end-of-parent drops). */
	parentLen: number;
	revealKind: string;
	el: HTMLElement;
}

/**
 * The block navigator: a tree popover of every container and section. Click
 * reveals (unfolding + switching tabs as needed); dragging a row reorders it
 * among its SIBLINGS — drop before a sibling, or after the parent's last row.
 */
function openNavigator(cst: Cst, root: HTMLElement, ctx: RenderCtx, e?: MouseEvent): void {
	closeActiveNavigator?.();
	const previousFocus = document.activeElement as HTMLElement | null;
	// Body-level + fixed: never clipped by the block, and it SURVIVES the
	// block re-renders that reveal/unfold trigger — so it stays open while
	// the user jumps between several targets. Outside click / Esc closes.
	const pop = document.body.createDiv({ cls: "mica-popover mica-navpop" });
	pop.setAttribute("role", "dialog");
	pop.setAttribute("aria-label", "Block navigator");
	const anchor = root.getBoundingClientRect();
	const clientX = e?.clientX ?? anchor.right;
	const clientY = e?.clientY ?? anchor.top;
	const left = Math.min(Math.max(8, clientX - 260), window.innerWidth - 348);
	const top = Math.min(clientY + 12, window.innerHeight - 120);
	pop.style.left = `${left}px`;
	pop.style.top = `${top}px`;
	pop.style.maxHeight = `${Math.max(120, window.innerHeight - top - 16)}px`;
	let closed = false;
	const dismiss = (): void => {
		if (closed) return;
		closed = true;
		pop.remove();
		document.removeEventListener("pointerdown", onOut, true);
		document.removeEventListener("keydown", onKey, true);
		if (previousFocus?.isConnected) previousFocus.focus();
		if (closeActiveNavigator === dismiss) closeActiveNavigator = null;
	};
	closeActiveNavigator = dismiss;
	(ctx.renderPassOwner ?? ctx.component).register(dismiss);
	const onOut = (ev: PointerEvent): void => {
		if (!pop.contains(ev.target as Node)) dismiss();
	};
	const onKey = (ev: KeyboardEvent): void => {
		if (ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			dismiss();
		}
	};
	document.addEventListener("pointerdown", onOut, true);
	document.addEventListener("keydown", onKey, true);

	const ICONS: Record<string, string> = {
		tabs: "app-window",
		tab: "corner-down-right",
		grid: "layout-grid",
		cell: "square",
		section: "group",
	};
	const rows: NavRow[] = [];

	const addRow = (depth: number, icon: string, label: string, count: number, nav: Omit<NavRow, "el">): void => {
		const el = pop.createDiv({ cls: "mica-nav-row" });
		el.style.paddingLeft = `${8 + depth * 16}px`;
		const ico = el.createSpan({ cls: "mica-nav-ico" });
		setIcon(ico, icon);
		el.createSpan({ cls: "mica-nav-label", text: label });
		if (count) el.createSpan({ cls: "mica-nav-count", text: `${count}w` });
		const row: NavRow = { ...nav, el };
		rows.push(row);
		wireNavRow(row, rows, ctx, root, dismiss);
	};

	const addSection = (
		parent: number[],
		parentLen: number,
		u: { start: number; end: number; md: string },
		depth: number,
	): void => {
		if (!u.md.trim()) return;
		const callout = parseCallout(u.md);
		let icon = "text";
		let label: string;
		if (callout) {
			icon =
				calloutCatalog(ctx.app).find((t) => t.id === callout.type || t.aliases.includes(callout.type))?.icon ??
				"megaphone";
			label = callout.title || `[!${callout.type}]`;
		} else if (u.md.trimStart().startsWith("\u0060\u0060\u0060")) {
			icon = "square-code";
			label = u.md.trimStart().slice(3).split("\n")[0].trim() || "code";
		} else {
			label = foldSummary(u.md);
			if (label.length > 34) label = `${label.slice(0, 34)}…`;
		}
		addRow(depth, icon, label, 0, {
			kind: "region",
			path: parent,
			parentPath: parent,
			index: u.start,
			end: u.end,
			parentLen,
			revealKind: "region",
		});
	};

	const walk = (nodes: MicaNode[], path: number[], depth: number, suppressDirectLeaves = false): void => {
		let i = 0;
		while (i < nodes.length) {
			const n = nodes[i];
			if (n.kind === "leaf") {
				const units = leafUnits(nodes, i);
				if (!suppressDirectLeaves) for (const u of units) addSection(path, nodes.length, u, depth);
				i = units.length ? units[units.length - 1].end : i + 1;
				continue;
			}
			const p = [...path, i];
			if (
				n.name === "tab" ||
				n.name === "cell" ||
				n.name === "tabs" ||
				n.name === "grid" ||
				n.name === "section"
			) {
				const [display] = splitTitleAttrs(n.title);
				const label =
					n.name === "section"
						? `Combined section · ${foldSummary(serializeCst({ children: n.children }))}`
						: display || n.name;
				addRow(depth, ICONS[n.name] ?? "square", label, wordCount(n.children), {
					kind: "container",
					path: p,
					parentPath: path,
					index: i,
					parentLen: nodes.length,
					revealKind: n.name,
				});
			}
			walk(n.children, p, depth + 1, n.name === "section");
			i++;
		}
	};
	walk(cst.children, [], 0);
	if (!rows.length) pop.createDiv({ cls: "mica-pop-empty", text: "Nothing here yet" });
	else requestAnimationFrame(() => rows[0]?.el.focus());
}

/** Click = reveal; drag (5px threshold) = reorder among same-parent rows. */
function wireNavRow(row: NavRow, rows: NavRow[], ctx: RenderCtx, root: HTMLElement, dismiss: () => void): void {
	// A keyboard path for the one structural affordance that lacked one:
	// Tab reaches rows, Enter/Space reveals, arrows walk the tree.
	row.el.setAttribute("role", "button");
	row.el.tabIndex = rows.length === 1 ? 0 : -1;
	row.el.addEventListener("keydown", (ke: KeyboardEvent) => {
		if (ke.key === "Enter" || ke.key === " ") {
			ke.preventDefault();
			for (const r of rows) r.el.removeClass("is-current");
			row.el.addClass("is-current");
			revealNode(ctx, root, {
				path: row.path,
				kind: row.revealKind,
				start: row.kind === "region" ? row.index : undefined,
			});
			return;
		}
		if (ke.key === "ArrowDown" || ke.key === "ArrowUp") {
			ke.preventDefault();
			const i = rows.indexOf(row);
			const next = rows[i + (ke.key === "ArrowDown" ? 1 : -1)]?.el;
			if (next) {
				row.el.tabIndex = -1;
				next.tabIndex = 0;
				next.focus();
			}
		}
		if (ke.key === "Home" || ke.key === "End") {
			ke.preventDefault();
			const next = ke.key === "Home" ? rows[0]?.el : rows.at(-1)?.el;
			if (next) {
				row.el.tabIndex = -1;
				next.tabIndex = 0;
				next.focus();
			}
		}
	});
	row.el.addEventListener("pointerdown", (down: PointerEvent) => {
		if (down.button !== 0) return;
		down.preventDefault();
		const startX = down.clientX;
		const startY = down.clientY;
		let dragging = false;
		let target: { row: NavRow; after: boolean } | null = null;
		const pk = row.parentPath.join(".");
		const siblings = rows.filter((r) => r.parentPath.join(".") === pk);
		const last = siblings[siblings.length - 1];

		const clearMarks = (): void => {
			for (const r of siblings) r.el.removeClass("mica-nav-dropbefore", "mica-nav-dropafter");
		};
		const isNoop = (t: { row: NavRow; after: boolean }): boolean => {
			const toIndex = t.after ? t.row.parentLen : t.row.index;
			if (row.kind === "region") return toIndex >= row.index && toIndex <= (row.end ?? row.index);
			return toIndex === row.index || toIndex === row.index + 1;
		};

		const home = row.el.getBoundingClientRect();
		const move = (ev: PointerEvent): void => {
			if (!dragging) {
				if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
				dragging = true;
				row.el.addClass("mica-nav-dragging");
			}
			clearMarks();
			target = null;
			// Home zone: wiggling within the row's own bounds offers nothing.
			if (
				ev.clientX >= home.left &&
				ev.clientX <= home.right &&
				ev.clientY >= home.top &&
				ev.clientY <= home.bottom
			)
				return;
			let bestDist = Number.POSITIVE_INFINITY;
			for (const r of siblings) {
				const rect = r.el.getBoundingClientRect();
				const mid = rect.top + rect.height / 2;
				const after = r === last && ev.clientY > mid;
				const cand = { row: r, after };
				if (isNoop(cand)) continue;
				const gapY = after ? rect.bottom : rect.top;
				const dist = Math.abs(ev.clientY - gapY);
				if (dist < bestDist) {
					bestDist = dist;
					target = cand;
				}
			}
			if (target) target.row.el.addClass(target.after ? "mica-nav-dropafter" : "mica-nav-dropbefore");
		};
		const onEsc = (ke: KeyboardEvent): void => {
			if (ke.key !== "Escape") return;
			ke.preventDefault();
			ke.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
			window.removeEventListener("keydown", onEsc, true);
			clearMarks();
			row.el.removeClass("mica-nav-dragging");
			dragging = false;
			target = null;
		};
		window.addEventListener("keydown", onEsc, true);
		const up = (ev: PointerEvent): void => {
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
			window.removeEventListener("keydown", onEsc, true);
			clearMarks();
			row.el.removeClass("mica-nav-dragging");
			if (!dragging) {
				// Plain click: reveal (unfold + switch tabs) but STAY OPEN —
				// the user may want to jump to several things in a row.
				for (const r of rows) r.el.removeClass("is-current");
				row.el.addClass("is-current");
				revealNode(ctx, root, {
					path: row.path,
					kind: row.revealKind,
					start: row.kind === "region" ? row.index : undefined,
				});
				return;
			}
			if (ev.type !== "pointerup" || !target) return;
			const toIndex = target.after ? target.row.parentLen : target.row.index;
			dismiss();
			if (row.kind === "region") {
				ctx.editable?.apply({
					op: "moveRegion",
					path: row.parentPath,
					start: row.index,
					end: row.end ?? row.index + 1,
					toParent: row.parentPath,
					toIndex,
				});
			} else {
				ctx.editable?.apply({
					op: "moveNode",
					from: row.path,
					toParent: row.parentPath,
					toIndex,
				});
			}
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	});
}

function wordCount(nodes: MicaNode[]): number {
	let n = 0;
	for (const c of nodes) {
		if (c.kind === "leaf") n += (c.text.match(/\S+/g) ?? []).length;
		else n += wordCount(c.children);
	}
	return n;
}

/**
 * Take the reader TO a node: activate every ancestor tab, scroll it into
 * view, and flash its bounds so the eye lands where the click meant.
 */
interface RevealSpec {
	path: number[];
	kind: string;
	/** Region targets: the unit's start index within `path`'s children. */
	start?: number;
}

function revealNode(ctx: RenderCtx, root: HTMLElement, spec: RevealSpec): void {
	// Folded ancestors (or a folded target) hide the destination entirely —
	// unfold first, re-render, THEN locate elements in the fresh DOM.
	if (ctx.ui) {
		let changed = false;
		for (let depth = 1; depth <= spec.path.length; depth++) {
			if (ctx.ui.folded.delete(nodeFoldKey(spec.path.slice(0, depth)))) changed = true;
		}
		if (spec.kind !== "region" && ctx.ui.folded.delete(nodeFoldKey(spec.path))) changed = true;
		if (spec.start !== undefined && ctx.ui.folded.delete(regionFoldKey(spec.path, spec.start))) changed = true;
		if (changed) {
			ctx.ui.persistFolds?.();
			ctx.rerenderBlock?.();
		}
	}
	// Activate the ancestor tab chain (chips carry their comma-joined path).
	for (let depth = 1; depth <= spec.path.length; depth++) {
		const prefix = spec.path.slice(0, depth);
		const chip = root.querySelector<HTMLElement>(`.mica-tab-btn[data-mica-tab="${prefix.join(",")}"]`);
		chip?.click();
	}
	const dotted = spec.path.join(".");
	let target: HTMLElement | null;
	if (spec.kind === "region" && spec.start !== undefined) {
		// Structural membership: the unit's element is the [data-mica-idx]
		// whose nearest container is the region's parent container.
		const parent = root.querySelector<HTMLElement>(`[data-mica-container="group"][data-path="${dotted}"]`);
		target = parent
			? (Array.from(parent.querySelectorAll<HTMLElement>(`[data-mica-idx="${spec.start}"]`)).find(
					(k) => k.parentElement?.closest("[data-mica-container]") === parent,
				) ?? null)
			: null;
	} else if (spec.kind === "tab") {
		// Tabs highlight their BODY (the panel content).
		target =
			root.querySelector<HTMLElement>(`[data-mica-container="group"][data-path="${dotted}"]`) ??
			root.querySelector<HTMLElement>(`[data-mica-node="${dotted}"]`);
	} else {
		target =
			root.querySelector<HTMLElement>(`[data-mica-node="${dotted}"]`) ??
			root.querySelector<HTMLElement>(`[data-path="${dotted}"]`);
	}
	if (!target) return;
	target.scrollIntoView({ block: "center", behavior: "smooth" });
	target.addClass("mica-flash");
	window.setTimeout(() => target.removeClass("mica-flash"), 1400);
}

/** Per-block appearance popover — writes fence attrs via the edit hooks. */
/** The block's effective accent as #rrggbb (for the color input's initial). */
function resolveAccentHex(el: HTMLElement): string {
	const probe = el.createSpan();
	probe.style.color = "var(--mica-accent)";
	const resolved = getComputedStyle(probe).color;
	probe.remove();
	const toHex = (channels: readonly number[]): string =>
		`#${channels
			.slice(0, 3)
			.map((channel) =>
				Math.max(0, Math.min(255, Math.round(channel)))
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
	const normalized = resolved.trim().toLowerCase();
	const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
	if (hex) {
		const full = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex.slice(0, 6);
		return `#${full}`;
	}
	if (normalized.startsWith("rgb")) {
		const values = normalized.match(/[\d.]+%?/g)?.slice(0, 3) ?? [];
		if (values.length === 3)
			return toHex(
				values.map((value) => (value.endsWith("%") ? (Number.parseFloat(value) * 255) / 100 : Number(value))),
			);
	}
	if (normalized.startsWith("color(srgb")) {
		const values =
			normalized
				.match(/[\d.]+/g)
				?.slice(0, 3)
				.map(Number) ?? [];
		if (values.length === 3) return toHex(values.map((value) => value * 255));
	}
	try {
		// Computed CSS colors may be rgb(), color(srgb …), display-p3, or
		// oklch() depending on Obsidian and the active theme. Let the browser
		// color engine rasterize one pixel rather than guessing from numbers in
		// an arbitrary color-space string.
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const painter = canvas.getContext("2d", { willReadFrequently: true });
		if (painter) {
			painter.clearRect(0, 0, 1, 1);
			painter.fillStyle = resolved;
			painter.fillRect(0, 0, 1, 1);
			const [red, green, blue, alpha] = painter.getImageData(0, 0, 1, 1).data;
			if (alpha) return toHex([red, green, blue]);
		}
	} catch {
		// A locked-down canvas should not make the appearance popover unusable.
	}
	return "#000000";
}

function openAppearance(el: HTMLElement, ctx: RenderCtx, resume = false, trackComponent = true): void {
	const existing = el.querySelector(".mica-appearance") as
		(HTMLElement & { micaClose?: (endSession?: boolean) => void }) | null;
	if (existing) {
		existing.micaClose?.();
		if (!existing.micaClose) existing.remove();
		if (!resume) return;
	}
	if (!existing) ctx.ui?.appearanceCleanup?.(false);
	if (ctx.ui) ctx.ui.appearanceOpen = true;
	const pop = el.createDiv({ cls: "mica-appearance" }) as HTMLElement & {
		micaClose?: (endSession?: boolean) => void;
	};
	// Every close path releases the document listener — a segment click must
	// not leave it armed until the next stray pointerdown.
	let closed = false;
	const done = (endSession = true): void => {
		if (closed) return;
		closed = true;
		if (endSession && ctx.ui) ctx.ui.appearanceOpen = false;
		if (ctx.ui?.appearanceCleanup === done) ctx.ui.appearanceCleanup = undefined;
		pop.remove();
		document.removeEventListener("pointerdown", onOut, true);
		document.removeEventListener("keydown", onEsc, true);
	};
	pop.micaClose = done;
	if (ctx.ui) ctx.ui.appearanceCleanup = done;
	// Attribute edits rebuild the CodeMirror widget. Tear down this DOM instance
	// without ending the session; the next render resumes the popover from BlockUi.
	if (trackComponent) ctx.component.register(() => done(false));
	function onOut(ev: PointerEvent): void {
		if (!pop.contains(ev.target as Node)) done();
	}
	function onEsc(ev: KeyboardEvent): void {
		if (ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			done();
		}
	}
	document.addEventListener("pointerdown", onOut, true);
	document.addEventListener("keydown", onEsc, true);

	pop.createDiv({ cls: "mica-appearance-title", text: "This block's appearance" });

	// Accent. An override here SHADOWS the global setting for this block —
	// say so explicitly, or the global control looks broken.
	const overridden = Boolean(ctx.blockAttrs?.["accent"]);
	const accentRow = pop.createDiv({ cls: "mica-appearance-row" });
	accentRow.createSpan({ cls: "mica-appearance-label", text: "Accent" });
	if (overridden)
		accentRow.createSpan({
			cls: "mica-appearance-override",
			text: "Local",
			attr: { title: "This block overrides the global accent" },
		});
	const color = accentRow.createEl("input", { attr: { type: "color" } });
	color.value = ctx.blockAttrs?.["accent"] ?? resolveAccentHex(el);
	color.addEventListener("change", () => setAppearanceAttr(el, ctx, "accent", color.value));
	const clearAccent = iconButton(
		accentRow,
		`mica-head-btn ${overridden ? "is-override" : ""}`,
		"rotate-ccw",
		overridden ? "Remove this block's override (follow the global accent)" : "Follow the theme accent",
	);
	clearAccent.addEventListener("click", () => setAppearanceAttr(el, ctx, "accent", null));

	// Density + tab style segments.
	const seg = (label: string, key: string, opts: [string, string][]): void => {
		const row = pop.createDiv({ cls: "mica-appearance-row is-segmented" });
		row.createSpan({ cls: "mica-appearance-label", text: label });
		const choices = row.createDiv({
			cls: `mica-appearance-segments${opts.length === 4 ? " is-four" : ""}`,
			attr: { role: "group", "aria-label": label },
		});
		const cur = ctx.blockAttrs?.[key] ?? "";
		for (const [value, text] of opts) {
			const b = choices.createEl("button", {
				cls: `clickable-icon mica-pop-seg ${cur === value ? "is-on" : ""}`,
				text,
				attr: { type: "button", "aria-pressed": String(cur === value) },
			});
			b.addEventListener("click", () => {
				setAppearanceAttr(el, ctx, key, value || null);
			});
		}
	};
	seg("Density", "density", [
		["", "Theme"],
		["comfortable", "Comfy"],
		["compact", "Compact"],
	]);
	seg("Tabs", "tabstyle", [
		["", "Theme"],
		["connected", "Connected"],
		["underline", "Underline"],
		["pill", "Pill"],
	]);
	seg("Outlines", "outline", [
		["", "Default"],
		["on", "On"],
		["off", "Off"],
	]);

	const radiusRow = pop.createDiv({ cls: "mica-appearance-row" });
	radiusRow.createSpan({ cls: "mica-appearance-label", text: "Radius" });
	const radiusOverridden = Boolean(ctx.blockAttrs?.["radius"]);
	if (radiusOverridden)
		radiusRow.createSpan({
			cls: "mica-appearance-override",
			text: "Local",
			attr: { title: "This block overrides the global radius" },
		});
	const slider = radiusRow.createEl("input", { attr: { type: "range", min: "0", max: "20", step: "1" } });
	// Seed from the EFFECTIVE radius (the block override, else the resolved
	// global) — a literal default would misrepresent unoverridden blocks.
	const effectiveRadius = parseFloat(getComputedStyle(el).getPropertyValue("--mica-radius"));
	slider.value = ctx.blockAttrs?.["radius"] ?? String(Number.isFinite(effectiveRadius) ? effectiveRadius : 10);
	slider.addEventListener("change", () => setAppearanceAttr(el, ctx, "radius", slider.value));
	const clearRadius = iconButton(
		radiusRow,
		`mica-head-btn ${radiusOverridden ? "is-override" : ""}`,
		"rotate-ccw",
		radiusOverridden ? "Remove this block's override (follow the global radius)" : "Follows the global radius",
	);
	clearRadius.addEventListener("click", () => setAppearanceAttr(el, ctx, "radius", null));

	pop.createDiv({
		cls: "mica-appearance-hint",
		text: "Saved into this block's header — travels with the note.",
	});
}

function setAppearanceAttr(el: HTMLElement, ctx: RenderCtx, key: string, value: string | null): void {
	if (!ctx.editable) return;
	const next = { ...(ctx.blockAttrs ?? {}) };
	if (value === null) delete next[key];
	else next[key] = value;
	ctx.blockAttrs = next;
	const blockId = el.dataset.micaBlockId;
	ctx.editable.setAttr(key, value);
	if (!ctx.ui?.appearanceOpen) return;
	let attempts = 0;
	const resume = (): void => {
		if (!ctx.ui?.appearanceOpen) return;
		const current = blockId
			? document.querySelector<HTMLElement>(`.mica-lp[data-mica-block-id="${CSS.escape(blockId)}"]`)
			: null;
		if (current?.isConnected && current !== el) {
			if (!current.querySelector(".mica-appearance")) openAppearance(current, ctx, true, false);
			return;
		}
		if (++attempts < 120) requestAnimationFrame(resume);
	};
	requestAnimationFrame(resume);
}

/** Reopen a persisted appearance session after CodeMirror replaces its widget.
 * Kept as a narrow renderer entry point so the widget lifecycle can retry
 * attachment with the fresh render context instead of stale DOM callbacks. */
export function resumeBlockAppearance(el: HTMLElement, ctx: RenderCtx): void {
	if (ctx.ui?.appearanceOpen && !el.querySelector(".mica-appearance")) openAppearance(el, ctx, true);
}

// ---------------------------------------------------------------------------
// Nodes, regions, insert zones
// ---------------------------------------------------------------------------

interface NodesOpts {
	insert?: boolean;
	autoOpen?: boolean;
}

/**
 * Split a leaf RUN starting at `from` into display units: leading spacing +
 * one content leaf + trailing spacing per unit. The renderer's regions and
 * the navigator's section rows both derive from this, so their `start`
 * indices (= `data-mica-idx`) can never disagree.
 */
function leafUnits(nodes: MicaNode[], from: number): { start: number; end: number; md: string }[] {
	const isLeaf = (n: number): boolean => n < nodes.length && nodes[n].kind === "leaf";
	const isWs = (n: number): boolean => isLeaf(n) && !(nodes[n] as Leaf).text.trim();
	const units: { start: number; end: number; md: string }[] = [];
	let i = from;
	while (isLeaf(i)) {
		let j = i;
		while (isWs(j)) j++;
		if (isLeaf(j)) j++;
		while (isWs(j)) j++;
		let md = "";
		for (let k = i; k < j; k++) md += (nodes[k] as Leaf).text;
		units.push({ start: i, end: j, md });
		i = j;
	}
	return units;
}

function renderNodes(nodes: MicaNode[], el: HTMLElement, ctx: RenderCtx, path: number[], opts: NodesOpts = {}): void {
	let i = 0;
	let opened = false;
	let lastContainerEl: HTMLElement | null = null;
	while (i < nodes.length) {
		if (nodes[i].kind === "leaf") {
			// The parser splits callouts and code fences into their own leaves;
			// each becomes its own region (grip + pencil). Whitespace-only
			// leaves glue to the PRECEDING unit so spacing between sections
			// never renders as a phantom empty region.
			for (const u of leafUnits(nodes, i)) {
				if (ctx.editable && u.start > 0) renderInsertZone(el, ctx, path, u.start);
				const auto: boolean = Boolean(opts.autoOpen) && !opened;
				renderRegion(
					el,
					ctx,
					{ path, start: u.start, end: u.end, original: u.md },
					auto,
					u.start === 0 && u.end === nodes.length,
				);
				opened = opened || auto;
				i = u.end;
			}
			lastContainerEl = null;
		} else {
			// Insert-between zones — including BEFORE the first section.
			if (ctx.editable) renderInsertZone(el, ctx, path, i);
			renderContainer(nodes[i] as Container, el, ctx, [...path, i]);
			lastContainerEl = el.lastElementChild as HTMLElement | null;
			i++;
		}
	}
	if (ctx.editable && nodes.length === 0) {
		renderRegion(el, ctx, { path, start: 0, end: 0, original: "" }, Boolean(opts.autoOpen) && !opened);
	}
	// Append-at-end is available EVERYWHERE there is already content — except
	// when this container ends with a tabs group whose every panel already
	// carries its own tail zone: two stacked lines in one visual gap read as
	// competing affordances. The inner line's menu still reaches this level
	// ("Below the tabs group…"). "Every panel" because tab switches toggle
	// classes without a re-render — any panel can become the visible one.
	const panels = lastContainerEl?.classList.contains("mica-tabs")
		? Array.from(lastContainerEl.querySelectorAll(":scope > .mica-tab-panels > .mica-tab-panel"))
		: [];
	const innerOwnsGap = panels.length > 0 && panels.every((p) => p.querySelector(".mica-insert-zone.is-tail"));
	if (ctx.editable && nodes.length > 0 && !innerOwnsGap) renderInsertZone(el, ctx, path, nodes.length, true);
}

/**
 * The one "insert something here" menu: prose, callout, code, tabs, or grid.
 * `onText` lets empty regions open their editor instead of inserting a stub.
 */
function showInsertMenu(
	ctx: RenderCtx,
	path: number[],
	at: number,
	e: MouseEvent,
	onText?: () => void,
	tail = false,
): void {
	const menu = ownMenu(ctx, new Menu());
	menu.addItem((i) =>
		i
			.setTitle("Text")
			.setIcon("text")
			.onClick(() => {
				if (onText) onText();
				else ctx.editable?.apply({ op: "insertLeaf", path, at, text: "Write here…\n" });
			}),
	);
	menu.addItem((i) =>
		i
			.setTitle("Callout")
			.setIcon("megaphone")
			.onClick(() => ctx.editable?.apply({ op: "insertLeaf", path, at, text: "> [!note] Title\n> Body\n" })),
	);
	menu.addItem((i) =>
		i
			.setTitle("Code block")
			.setIcon("square-code")
			.onClick(() =>
				ctx.editable?.apply({
					op: "insertLeaf",
					path,
					at,
					text: "\u0060\u0060\u0060\ncode\n\u0060\u0060\u0060\n",
				}),
			),
	);
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle("Tabs")
			.setIcon("app-window")
			.onClick(() => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "tabs" })),
	);
	menu.addItem((i) =>
		i
			.setTitle("Grid")
			.setIcon("layout-grid")
			.onClick(() => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "grid" })),
	);
	// A tab body's tail zone owns the visual gap BELOW its whole tabs group
	// (that level's own zone is suppressed to keep one line per gap) — reach
	// the outer level from here. Chained menus handle nested tabs naturally.
	if (tail && path.length >= 2) {
		const groupPath = path.slice(0, -1);
		const group = nodeAtPath(ctx.rootNodes ?? [], groupPath);
		if (group?.kind === "container" && group.name === "tabs") {
			const parentPath = groupPath.slice(0, -1);
			const parent = parentPath.length ? nodeAtPath(ctx.rootNodes ?? [], parentPath) : null;
			const siblings = parentPath.length
				? parent?.kind === "container"
					? parent.children
					: null
				: (ctx.rootNodes ?? null);
			const gIdx = groupPath[groupPath.length - 1];
			if (siblings && gIdx === siblings.length - 1) {
				menu.addSeparator();
				menu.addItem((i) =>
					i
						.setTitle("Below the tabs group…")
						.setIcon("corner-down-right")
						.onClick(() => showInsertMenu(ctx, parentPath, gIdx + 1, e, undefined, true)),
				);
			}
		}
	}
	menu.showAtMouseEvent(e);
}

/**
 * Insert a cell at flow position `at`, choosing its content type — used by the
 * "+" tile and the vertical column strips. `extra` appends context items
 * (e.g. "New column").
 */
function showCellTypeMenu(
	ctx: RenderCtx,
	gridPath: number[],
	at: number,
	e: MouseEvent,
	extra?: (menu: Menu) => void,
): void {
	const menu = ownMenu(ctx, new Menu());
	const addCellWith = (follow?: StructOp): void => {
		ctx.editable?.apply({ op: "insertCell", path: gridPath, at });
		// The second op targets the fresh cell; each dispatch re-scans the live
		// document, so chaining is corruption-proof.
		if (follow) window.setTimeout(() => ctx.editable?.apply(follow), 0);
	};
	menu.addItem((i) =>
		i
			.setTitle("Text")
			.setIcon("text")
			.onClick(() => {
				if (ctx.ui) ctx.ui.reveal = { path: [...gridPath, at], kind: "region-edit" };
				ctx.editable?.apply({ op: "insertCell", path: gridPath, at });
			}),
	);
	menu.addItem((i) =>
		i
			.setTitle("Callout")
			.setIcon("megaphone")
			.onClick(() =>
				addCellWith({ op: "insertLeaf", path: [...gridPath, at], at: 0, text: "> [!note] Title\n> Body\n" }),
			),
	);
	menu.addItem((i) =>
		i
			.setTitle("Code block")
			.setIcon("square-code")
			.onClick(() =>
				addCellWith({
					op: "insertLeaf",
					path: [...gridPath, at],
					at: 0,
					text: "\u0060\u0060\u0060\ncode\n\u0060\u0060\u0060\n",
				}),
			),
	);
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle("Tabs")
			.setIcon("app-window")
			.onClick(() => addCellWith({ op: "insertGroup", path: [...gridPath, at], at: 0, kind: "tabs" })),
	);
	menu.addItem((i) =>
		i
			.setTitle("Grid (nested)")
			.setIcon("layout-grid")
			.onClick(() => addCellWith({ op: "insertGroup", path: [...gridPath, at], at: 0, kind: "grid" })),
	);
	extra?.(menu);
	menu.showAtMouseEvent(e);
}

// What a region click must NOT hijack. Deliberately `.mica-mdeditor` and not
// `.cm-editor`: in Live Preview the whole widget lives inside the NOTE's
// .cm-editor, so matching that would swallow every region click.
const INTERACTIVE = "a, button, input, textarea, .internal-link, .mica-mdeditor";

function openSectionEditor(region: HTMLElement, ctx: RenderCtx, target: RegionTarget): void {
	if (target.logical) {
		openQuickEdit(region, ctx, target);
		return;
	}
	if (parseCodeFence(target.original)) {
		openCodeBlockEditor(ctx, target);
		return;
	}
	if (parseCallout(target.original)) {
		openCalloutEditor(ctx, target);
		return;
	}
	openQuickEdit(region, ctx, target);
}

const sectionKindLabel = (kind: SectionKind): string =>
	kind === "markdown" ? "Markdown" : kind === "callout" ? "Callout" : "Code block";

function convertRegion(ctx: RenderCtx, target: RegionTarget, to: SectionKind): void {
	if (target.logical) return;
	const converted = convertSection(target.original, to);
	if (converted.text === target.original) return;
	const warnings = converted.warnings.map((warning) => warning.message).join(" ");
	const notice = `Converted to ${sectionKindLabel(to)}${warnings ? ` — ${warnings}` : ""}`;
	applyWithUndo(
		ctx,
		{
			op: "saveRegion",
			path: target.path,
			start: target.start,
			end: target.end,
			expected: target.original,
			text: converted.text,
		},
		notice,
	);
}

function combineOp(source: CombineSpec, target: CombineSpec, allowMixed = false): StructOp {
	return {
		op: "combineRegions",
		allowMixed,
		sourcePath: source.path,
		sourceStart: source.start,
		sourceEnd: source.end,
		sourceExpected: source.expected,
		targetPath: target.path,
		targetStart: target.start,
		targetEnd: target.end,
		targetExpected: target.expected,
	};
}

/** Keyboard/touch alternative to the dwell gesture: expose the nearest
 * compatible sections in document order through the ordinary Obsidian menu. */
/** Longest run offered in one action. Beyond this the menu stops being a menu,
 * and the result can simply be combined again. */
const MAX_COMBINE_RUN = 6;

/**
 * Merge this region together with the next `count` siblings.
 *
 * Offered as one action per reachable length rather than a bespoke multi-select:
 * naming the far end of the run *is* selecting the run, and it works from the
 * keyboard, from a context menu, and under a coarse pointer without inventing a
 * selection mode that only exists here.
 */
function combineRunActions(region: HTMLElement, ctx: RenderCtx, target: RegionTarget): ActionSpec[] {
	const source = combineSpecFor(target);
	if (!source) return [];
	// Built once per render by `rebuildCombineIndex`; rescanning here would make
	// every menu cost a document-wide pass.
	const ordered = ctx.combineOrder ?? [];
	const at = ctx.combineNeighbors?.get(region as CombineTargetElement)?.index ?? -1;
	if (at < 0 || at >= ordered.length) return [];

	// A run is only meaningful among siblings of one container whose child
	// indices touch; anything else is a different structural operation.
	//
	// The walk is capped rather than following the run to its end: this builds
	// once per action menu, and a block of many sections would otherwise make
	// menu construction quadratic. Longer runs remain reachable by combining
	// the result again.
	const run: CombineSpec[] = [ordered[at]];
	const limit = Math.min(ordered.length, at + MAX_COMBINE_RUN);
	for (let next = at + 1; next < limit; next++) {
		const previous = run[run.length - 1];
		const candidate = ordered[next];
		if (!samePath(candidate.path, previous.path) || candidate.start !== previous.end) break;
		run.push(candidate);
	}
	if (run.length < 3) return []; // two is the ordinary pairwise combine

	const actions: ActionSpec[] = [];
	for (let length = 3; length <= run.length; length++) {
		const slice = run.slice(0, length);
		const last = slice[slice.length - 1];
		const expected = slice.map((spec) => spec.expected).join("");
		actions.push({
			id: `combine-run-${length}`,
			label: `Combine the next ${length} sections`,
			icon: "between-horizontal-start",
			run: () =>
				applyWithUndo(
					ctx,
					{
						op: "combineRun",
						path: [...slice[0].path],
						start: slice[0].start,
						end: last.end,
						expected,
						allowMixed: slice.some((spec) => spec.key !== "markdown"),
					},
					`${length} sections combined`,
				),
		});
	}
	return actions;
}

function combineActions(region: HTMLElement, ctx: RenderCtx, target: RegionTarget): ActionSpec[] {
	const source = combineSpecFor(target);
	if (!source) return [];
	const indexed = ctx.combineNeighbors?.get(region as CombineTargetElement);
	if (!indexed) return [];
	const neighbors = [
		{ destination: indexed.previous, direction: "previous" },
		{ destination: indexed.next, direction: "next" },
	].filter((entry): entry is { destination: CombineSpec; direction: string } => Boolean(entry.destination));
	return neighbors.flatMap(({ destination, direction }, index) => {
		const where = direction === "previous" ? "above" : "below";
		return [
			{
				id: `combine-${direction}`,
				label: `Combine with section ${where}`,
				icon: direction === "previous" ? "arrow-up-to-line" : "arrow-down-to-line",
				separatorBefore: index === 0,
				run: () => applyWithUndo(ctx, combineOp(source, destination), "Sections combined"),
			},
			{
				// Offered separately because it dissolves a callout or code block
				// into the merged section instead of leaving it addressable. The
				// bytes are preserved either way.
				id: `combine-${direction}-mixed`,
				label: `Combine with section ${where} as Markdown`,
				icon: "merge",
				run: () => applyWithUndo(ctx, combineOp(source, destination, true), "Sections combined as Markdown"),
			},
		];
	});
}

function sectionActions(region: HTMLElement, ctx: RenderCtx, target: RegionTarget): ActionSpec[] {
	const actions: ActionSpec[] = [copyAction(ctx, regionCopyControl(target, ctx))];
	if (target.logical) {
		if (ctx.editable)
			actions.push(
				{
					id: "edit",
					label: "Edit combined source",
					icon: "file-code",
					run: () => openQuickEdit(region, ctx, target),
				},
				{
					// A combined section is edited as one source region, exactly
					// like any other; there is no reason the larger editor should
					// be the one surface it cannot use.
					id: "lightbox",
					label: "Edit combined source in lightbox",
					icon: "maximize-2",
					run: () => openLightboxFor(ctx, target),
				},
				{
					id: "uncombine",
					label: "Uncombine section",
					icon: "separator-horizontal",
					run: () =>
						applyWithUndo(
							ctx,
							{ op: "uncombineSection", path: target.logical!.path },
							"Section uncombined",
						),
				},
			);
		actions.push(...combineActions(region, ctx, target), ...combineRunActions(region, ctx, target));
	} else if (ctx.editable) {
		const kind = classifySection(target.original);
		actions.push(
			{ id: "edit", label: "Edit source", icon: "file-code", run: () => openQuickEdit(region, ctx, target) },
			{
				id: "lightbox",
				label: "Edit source in lightbox",
				icon: "maximize-2",
				run: () => openLightboxFor(ctx, target),
			},
		);
		if (kind === "callout") {
			actions.push({
				id: "fields",
				label: "Edit callout fields…",
				icon: "megaphone",
				run: () => openCalloutEditor(ctx, target),
			});
		} else if (kind === "code") {
			actions.push({
				id: "fields",
				label: "Edit language and code…",
				icon: "file-code-2",
				run: () => openCodeBlockEditor(ctx, target),
			});
		}
		for (const destination of ["markdown", "callout", "code"] as const) {
			if (destination === kind) continue;
			actions.push({
				id: `convert-${destination}`,
				label: `Convert to ${sectionKindLabel(destination)}`,
				icon: destination === "markdown" ? "text" : destination === "callout" ? "megaphone" : "square-code",
				separatorBefore: actions.every((action) => !action.id.startsWith("convert-")),
				run: () => convertRegion(ctx, target, destination),
			});
		}
		actions.push(...combineActions(region, ctx, target), ...combineRunActions(region, ctx, target));
	}
	if (ctx.editable) {
		const fkey = foldKeyForRegion(target);
		actions.push(
			{
				id: "fold",
				label: "Fold this section",
				icon: "chevrons-down-up",
				separatorBefore: true,
				run: () => toggleFold(ctx, fkey),
			},
			{
				id: "delete",
				label: "Delete this section",
				icon: "trash-2",
				danger: true,
				separatorBefore: true,
				run: () => {
					const op: StructOp = target.logical
						? { op: "deleteNode", path: target.logical.path }
						: {
								op: "saveRegion",
								path: target.path,
								start: target.start,
								end: target.end,
								expected: target.original,
								text: "",
							};
					deleteWithUndo(ctx, op, "Section deleted");
				},
			},
		);
	}
	return filterSectionActions(actions, ctx.hiddenSectionActions);
}

function populateSectionMenu(menu: Menu, region: HTMLElement, ctx: RenderCtx, target: RegionTarget): void {
	populateActionMenu(menu, sectionActions(region, ctx, target));
}

function renderRegion(
	el: HTMLElement,
	ctx: RenderCtx,
	target: RegionTarget,
	autoOpen: boolean,
	sole = false,
): HTMLElement {
	const region = el.createDiv({ cls: `mica-region ${sole ? "is-sole" : ""}` });
	const combine = combineSpecFor(target);
	if (combine) {
		const combineRegion = region as CombineTargetElement;
		combineRegion.micaCombine = combine;
		ctx.combineTargets?.push(combineRegion);
	}
	const logicalIndex = target.logical?.path[target.logical.path.length - 1];
	if (logicalIndex !== undefined) region.setAttribute("data-mica-idx", String(logicalIndex));
	else if (target.start < target.end) region.setAttribute("data-mica-idx", String(target.start));
	const classified = target.logical ? "markdown" : classifySection(target.original);
	const inspectKind = classified === "markdown" ? "section" : classified;
	markInspectable(
		region,
		ctx,
		target.logical
			? `${inspectKind}:${target.logical.path.join(".")}`
			: `${inspectKind}:${target.path.join(".")}:${target.start}-${target.end}`,
	);
	paintRegionView(region, ctx, target);

	if (ctx.editable) {
		const guard = (e: Event): boolean => !(e.target as HTMLElement).closest(INTERACTIVE);
		region.addEventListener("click", (e) => {
			if (!guard(e) || region.hasClass("is-editing")) return;
			e.preventDefault();
			e.stopPropagation();
			if (region.hasClass("is-folded")) {
				toggleFold(ctx, foldKeyForRegion(target));
				return;
			}
			if (!target.original.trim()) {
				// Empty space offers the full palette (text / callout / code / groups).
				showInsertMenu(ctx, target.path, target.start, e, () => openQuickEdit(region, ctx, target));
				return;
			}
			if (e.ctrlKey || e.metaKey) openLightboxFor(ctx, target);
			else openSectionEditor(region, ctx, target);
		});
		region.addEventListener("contextmenu", (e) => {
			if (region.hasClass("is-editing")) return;
			e.preventDefault();
			const menu = ownMenu(ctx, new Menu());
			populateSectionMenu(menu, region, ctx, target);
			menu.showAtMouseEvent(e);
		});
	}

	// A surviving draft for this region reopens the editor seamlessly.
	const draft = ctx.ui?.draft;
	if (ctx.editable && draft && draft.key === draftKey(target)) {
		queueMicrotask(() => openQuickEdit(region, ctx, { ...target, original: draft.expected }, draft.text));
		return region;
	}
	if (autoOpen && ctx.editable) queueMicrotask(() => openQuickEdit(region, ctx, target));
	return region;
}

/**
 * Callouts nested INSIDE a callout are text, not structure — but they still
 * deserve tools. Each rendered `.callout .callout` is zipped (document
 * order) with its source line range; edit/delete/drag all run as guarded
 * text surgery on the parent region.
 */
function wireNestedCallouts(
	view: HTMLElement,
	ctx: RenderCtx,
	target: RegionTarget,
	nested: readonly NestedCallout[],
): void {
	if (!nested.length) return;
	const rendered = Array.from(view.querySelectorAll<HTMLElement>(".callout .callout"));
	nested.forEach((nc, i) => {
		const el = rendered[i];
		if (!el) return;
		el.addClass("mica-nested-callout");
		const tools = el.createDiv({ cls: "mica-region-tools mica-nested-tools" });
		const stop = (e: Event): void => e.stopPropagation();
		const nestedText = (): string => dedentNested(target.original, nc);
		const copy: CopyControl = {
			kind: "nested-callout",
			label: "Copy nested callout",
			notice: "Nested callout copied.",
			path: [...target.path, target.start, i],
			target: () => ({ text: nestedText() }),
		};
		const without = (): string => spliceLines(target.original, nc.startLine, nc.endLine, null);
		if (ctx.editable) {
			const grip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag this callout out");
			grip.addEventListener("click", stop);
			makeDraggable(
				grip,
				{
					kind: "region",
					fromPath: target.path,
					text: nestedText,
					virtualSplice: {
						path: target.path,
						start: target.start,
						end: target.end,
						expected: target.original,
						without,
						insertCount: () => parseBlock(nestedText()).children.length,
					},
				},
				target.path,
				(op) => ctx.editable?.apply(op),
				el,
			);
		}
		entityMenu(
			tools,
			ctx,
			() => {
				const actions: ActionSpec[] = [copyAction(ctx, copy)];
				if (!ctx.editable) return actions;
				actions.push({
					id: "edit",
					label: "Edit this callout",
					icon: "maximize-2",
					run: () => {
						const parsed = parseCallout(nestedText());
						if (!parsed) return;
						openCalloutEditorFor(ctx, parsed, (rebuilt) => {
							const next = spliceLines(
								target.original,
								nc.startLine,
								nc.endLine,
								requoteOnce(rebuilt).trimEnd(),
							);
							if (next === target.original) return;
							const accepted =
								ctx.editable?.apply({
									op: "saveRegion",
									path: target.path,
									start: target.start,
									end: target.end,
									expected: target.original,
									text: next,
								}) ?? false;
							if (!accepted)
								new Notice(
									"Mica: the callout changed while you were editing. Your edit is still open.",
								);
							return accepted;
						});
					},
				});
				actions.push({
					id: "delete",
					label: "Delete this callout",
					icon: "trash-2",
					danger: true,
					separatorBefore: true,
					run: () =>
						deleteWithUndo(
							ctx,
							{
								op: "saveRegion",
								path: target.path,
								start: target.start,
								end: target.end,
								expected: target.original,
								text: without(),
							},
							"Nested callout deleted",
						),
				});
				return actions;
			},
			"Nested callout actions",
		);
	});
}

/**
 * Add first-class controls to fenced code that lives inside a callout's quoted
 * source. Source ranges remain authoritative; DOM nodes are used only when
 * Obsidian produced an unambiguous one-to-one list of native `<pre>` renders.
 * Community processors that replace or add code DOM therefore degrade safely
 * to the parent callout editor instead of receiving controls for the wrong
 * source span.
 */
function wireNestedCodeBlocks(
	view: HTMLElement,
	ctx: RenderCtx,
	target: RegionTarget,
	nested: readonly NestedCodeBlock[],
): void {
	if (!nested.length) return;
	const rendered = Array.from(view.querySelectorAll<HTMLElement>("pre"));
	if (rendered.length !== nested.length) return;

	nested.forEach((code, i) => {
		const pre = rendered[i];
		if (!pre) return;
		const host = (pre.closest(".el-pre") as HTMLElement | null) ?? pre.parentElement;
		if (!host || host.closest(".mica-region") !== view.parentElement) return;
		host.addClass("mica-nested-code");
		const tools = host.createDiv({ cls: "mica-region-tools mica-nested-tools mica-nested-code-tools" });
		const nestedText = (): string => materializeQuotedSection(target.original, code);
		const copy: CopyControl = {
			kind: "nested-code",
			label: "Copy nested code block",
			notice: "Nested code block copied.",
			path: [...target.path, target.start, i],
			target: () => ({ text: nestedText() }),
		};
		const without = (): string => spliceQuotedSection(target.original, code, null);
		if (ctx.editable) {
			const grip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag this code block out");
			grip.addEventListener("click", (event) => event.stopPropagation());
			makeDraggable(
				grip,
				{
					kind: "region",
					fromPath: target.path,
					text: nestedText,
					virtualSplice: {
						path: target.path,
						start: target.start,
						end: target.end,
						expected: target.original,
						without,
						insertCount: () => parseBlock(nestedText()).children.length,
					},
				},
				target.path,
				(op) => ctx.editable?.apply(op),
				host,
			);
		}
		const parsed = parseCodeFence(nestedText());
		entityMenu(
			tools,
			ctx,
			() => {
				const actions: ActionSpec[] = [copyAction(ctx, copy)];
				if (!ctx.editable) return actions;
				if (parsed)
					actions.push({
						id: "edit",
						label: "Edit this code block",
						icon: "file-code-2",
						run: () => {
							openCodeBlockEditorFor(ctx, parsed, (rebuilt) => {
								// Saving an untouched nested editor must be a byte-for-byte no-op;
								// requoting is needed only after an actual structured change.
								if (rebuilt === nestedText()) return true;
								const next = spliceQuotedSection(target.original, code, rebuilt);
								if (next === target.original) return true;
								const accepted =
									ctx.editable?.apply({
										op: "saveRegion",
										path: target.path,
										start: target.start,
										end: target.end,
										expected: target.original,
										text: next,
									}) ?? false;
								if (!accepted)
									new Notice(
										"Mica: the code block changed while you were editing. Your edit is still open.",
									);
								return accepted;
							});
						},
					});
				actions.push({
					id: "delete",
					label: "Delete this code block",
					icon: "trash-2",
					danger: true,
					separatorBefore: true,
					run: () =>
						deleteWithUndo(
							ctx,
							{
								op: "saveRegion",
								path: target.path,
								start: target.start,
								end: target.end,
								expected: target.original,
								text: without(),
							},
							"Nested code block deleted",
						),
				});
				return actions;
			},
			"Nested code block actions",
		);
	});
}

function paintRegionView(region: HTMLElement, ctx: RenderCtx, target: RegionTarget): void {
	region.empty();
	region.removeClass("is-editing");
	region.toggleClass("is-editable", Boolean(ctx.editable));
	const fkey = foldKeyForRegion(target);
	if (ctx.ui?.folded.has(fkey) && target.original.trim()) {
		renderFoldBar(region, ctx, fkey, target.logical ? "group" : "text", foldSummary(target.original), {
			path: target.logical?.path ?? target.path,
			region: target.logical ? undefined : { start: target.start, end: target.end },
			combine: combineSpecFor(target) ?? undefined,
			itemEl: region,
			text: target.logical?.source ?? target.original,
			copy: regionCopyControl(target, ctx),
		});
		return;
	}
	region.removeClass("is-folded");
	const view = region.createDiv({ cls: "mica-md" });
	if (target.original.trim()) {
		renderMarkdown(target.original, view, ctx);
		const tools = region.createDiv({ cls: "mica-region-tools" });
		if (ctx.editable) {
			const grip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag to move · click text to edit");
			grip.addEventListener("click", (e) => e.stopPropagation());
			makeDraggable(
				grip,
				target.logical
					? {
							kind: "group",
							fromPath: target.logical.path,
							combine: combineSpecFor(target) ?? undefined,
							text: target.logical.source,
						}
					: {
							kind: "region",
							fromPath: target.path,
							region: { start: target.start, end: target.end },
							combine: combineSpecFor(target) ?? undefined,
							text: target.original,
						},
				target.logical?.path ?? target.path,
				(op) => applyDragOp(ctx, op),
				region,
			);
		}
		entityMenu(tools, ctx, () => sectionActions(region, ctx, target), "Section actions");
		const nested = findNestedSections(target.original);
		wireNestedCallouts(view, ctx, target, nested.callouts);
		wireNestedCodeBlocks(view, ctx, target, nested.codeBlocks);
	} else if (ctx.editable) {
		const ghost = view.createDiv({ cls: "mica-ghost" });
		setIcon(ghost.createSpan({ cls: "mica-ghost-icon" }), "plus");
		ghost.createSpan({ cls: "mica-ghost-label", text: "Add…" });
	}
}

/**
 * A slim hover zone between siblings: insert tabs / grid / callout / code /
 * text exactly here — the "can't put prose between two groups" fix.
 */
function renderInsertZone(el: HTMLElement, ctx: RenderCtx, path: number[], at: number, tail = false): void {
	const zone = el.createDiv({ cls: `mica-insert-zone ${tail ? "is-tail" : ""}` });
	const line = zone.createDiv({ cls: "mica-insert-line" });
	void line;
	const btn = iconButton(zone, "mica-insert-plus", "plus", "Insert here…");
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		showInsertMenu(ctx, path, at, e, undefined, tail);
	});
}

/** The node at a root-relative child-index path (null when it dead-ends). */
function nodeAtPath(nodes: readonly MicaNode[], path: readonly number[]): MicaNode | null {
	let cur: MicaNode | null = null;
	let list: readonly MicaNode[] = nodes;
	for (const idx of path) {
		cur = list[idx] ?? null;
		if (!cur) return null;
		list = cur.kind === "container" ? cur.children : [];
	}
	return cur;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function renderContainer(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	if (node.name === "tabs") {
		renderTabs(node, el, ctx, path);
	} else if (node.name === "grid") {
		renderGrid(node, el, ctx, path);
	} else if (node.name === "section") {
		renderLogicalSection(node, el, ctx, path);
	} else {
		const box = el.createDiv({ cls: `mica-${node.name}` });
		renderNodes(node.children, box, ctx, path, { autoOpen: takeRegionReveal(ctx, path) });
	}
}

function renderLogicalSection(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const source = serializeCst({ children: [node] });
	const body = serializeCst({ children: node.children });
	const region = renderRegion(
		el,
		ctx,
		{
			path,
			start: 0,
			end: node.children.length,
			original: body,
			logical: { path, source, node },
		},
		false,
	);
	region.addClass("mica-logical-section");
}

function renderTabs(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const wrap = el.createDiv({ cls: "mica-tabs" });
	markInspectable(wrap, ctx, `tabs:${path.join(".")}`);
	wrap.setAttribute("data-mica-idx", String(path[path.length - 1] ?? 0));
	wrap.setAttribute("data-mica-node", path.join("."));
	const tkey = nodeFoldKey(path);
	if (ctx.ui?.folded.has(tkey)) {
		const n = node.children.filter((c) => c.kind === "container" && c.name === "tab").length;
		renderFoldBar(wrap, ctx, tkey, "app-window", `Tabs · ${n}`, {
			path,
			itemEl: wrap,
			text: serializeCst({ children: [node] }),
			copy: {
				kind: "tabs",
				label: "Copy tab group contents",
				notice: "Tab group copied.",
				path,
				target: { nodes: [node] },
			},
			unfoldLabel: "Unfold this tab group",
		});
		return;
	}
	const navOuter = wrap.createDiv({ cls: "mica-tab-nav-outer" });
	const nav = navOuter.createDiv({ cls: "mica-tab-nav", attr: { role: "tablist" } });
	nav.setAttribute("data-mica-container", "tab");
	nav.setAttribute("data-path", path.join("."));
	nav.setAttribute("data-len", String(node.children.length));
	nav.setAttribute("data-axis", "x");
	const panels = wrap.createDiv({ cls: "mica-tab-panels" });
	const tabs = node.children
		.map((c, idx) => ({ c, idx }))
		.filter((x) => x.c.kind === "container" && x.c.name === "tab");

	let revealTab = -1;
	const r = ctx.ui?.reveal;
	if (r && r.kind === "tab-edit" && prefixOf(path, r.path)) {
		revealTab = r.path[r.path.length - 1];
		ctx.ui!.reveal = null;
	}
	const pk = pathKey(path);
	let active = revealTab >= 0 ? tabs.findIndex((x) => x.idx === revealTab) : (ctx.ui?.active.get(pk) ?? 0);
	if (active >= tabs.length) active = tabs.length - 1;
	if (active < 0) active = 0;

	const btns: HTMLButtonElement[] = [];
	const panelEls: HTMLElement[] = [];
	const activate = (k: number, focus = false): void => {
		btns.forEach((b, m) => {
			b.toggleClass("is-active", m === k);
			b.setAttribute("aria-selected", String(m === k));
			b.tabIndex = m === k ? 0 : -1;
		});
		panelEls.forEach((p, m) => p.toggleClass("is-active", m === k));
		ctx.ui?.active.set(pk, k);
		if (!ctx.buildingCombineIndex) ctx.rebuildCombineIndex?.();
		if (focus) btns[k]?.focus();
	};

	tabs.forEach((x, k) => {
		const tab = x.c as Container;
		const [display] = splitTitleAttrs(tab.title);
		const icon = titleAttr(tab.title, "icon");
		const chip = nav.createDiv({ cls: "mica-tab-chip" });
		markInspectable(chip, ctx, `tab:${[...path, x.idx].join(".")}`);
		chip.addClass("mica-chip-copyable");
		chip.setAttribute("data-mica-idx", String(x.idx));
		const btn = chip.createEl("button", {
			cls: "mica-tab-btn",
			attr: { type: "button", role: "tab", "data-mica-tab": [...path, x.idx].join(",") },
		});
		if (icon)
			setMicaIcon(
				btn.createSpan({ cls: "mica-tab-icon" }),
				icon,
				ctx.chip?.plugin.settings.enabledIconPacks ?? [],
			);
		btn.createSpan({ text: display || `Tab ${k + 1}` });
		btn.addEventListener("click", () => activate(k));
		const tabCopy: CopyControl = {
			kind: "tab",
			label: `Copy tab “${display || `Tab ${k + 1}`}” contents`,
			notice: "Tab copied.",
			path: [...path, x.idx],
			target: { nodes: [tab] },
		};
		const tabMenu = entityMenu(
			chip,
			ctx,
			() => tabActions(ctx, path, x.idx, display, tab.title, chip, btn, tabCopy),
			"Tab actions",
			"mica-chip-menu",
			{
				menuOnly: true,
				className: ctx.showTabActionMenuOnHover === false ? "mica-tab-menu-hidden" : "mica-tab-menu-hover",
			},
		);
		if (ctx.showTabActionMenuOnHover === false) {
			tabMenu?.element
				.querySelector<HTMLButtonElement>('[data-mica-responsive-role="overflow"]')
				?.setAttribute("tabindex", "-1");
		}
		btn.addEventListener("keydown", (event) => {
			if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
			event.preventDefault();
			event.stopPropagation();
			chip.querySelector<HTMLButtonElement>('[data-mica-responsive-role="overflow"]')?.click();
		});

		if (ctx.editable) {
			chip.addClass("mica-chip-editable");
			btn.addEventListener("dblclick", (e) => {
				e.preventDefault();
				startRename(chip, btn, ctx, path, x.idx, display, tab.title);
			});
			chip.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				ownMenu(
					ctx,
					showActionMenuAtEvent(e, tabActions(ctx, path, x.idx, display, tab.title, chip, btn, tabCopy)),
				);
			});
			makeDraggable(chip, "tab", [...path, x.idx], (op) => ctx.editable?.apply(op), chip);
			const pendingRename = ctx.ui?.tabRename;
			if (pendingRename && pendingRename.path === path.join(".") && pendingRename.index === x.idx) {
				queueMicrotask(() => {
					if (chip.isConnected && !chip.querySelector(".mica-rename"))
						startRename(chip, btn, ctx, path, x.idx, display, tab.title, true);
				});
			}
			// Keyboard reorder: Alt+←/→ moves the focused tab.
			btn.addEventListener("keydown", (e) => {
				if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
				e.preventDefault();
				e.stopPropagation();
				const target = e.key === "ArrowLeft" ? x.idx - 1 : x.idx + 2;
				if (target < 0) return;
				ctx.editable?.apply({ op: "moveNode", from: [...path, x.idx], toParent: path, toIndex: target });
			});
		}
		const panel = panels.createDiv({ cls: "mica-tab-panel", attr: { role: "tabpanel" } });
		// The chip already numbers this tab; the panel only takes the outline.
		markInspectable(panel, ctx, `tab:${[...path, x.idx].join(".")}`, false);
		const body = panel.createDiv({ cls: "mica-tab-body" });
		markGroupContainer(body, [...path, x.idx], tab.children.length);
		// A freshly inserted tab is ACTIVATED but never auto-opens an editor —
		// its empty body offers the "+ Add…" menu instead.
		renderNodes(tab.children, body, ctx, [...path, x.idx], { insert: true });
		btns.push(btn);
		panelEls.push(panel);
	});

	if (ctx.editable) {
		iconButton(nav, "mica-add mica-tab-add", "plus", "Add a tab").addEventListener("click", () =>
			ctx.editable?.apply({ op: "insertTab", path, at: node.children.length }),
		);
	}
	const sticky = navOuter.createDiv({ cls: "mica-tab-nav-sticky" });
	// All-tabs menu (find a tab when the strip overflows).
	if (tabs.length > 5) {
		iconButton(sticky, "mica-head-btn", "chevron-down", "All tabs…").addEventListener("click", (e) => {
			const menu = ownMenu(ctx, new Menu());
			tabs.forEach((x, k) => {
				const [display] = splitTitleAttrs((x.c as Container).title);
				menu.addItem((i) =>
					i.setTitle(display || `Tab ${k + 1}`).onClick(() => {
						activate(k, true);
						btns[k]?.scrollIntoView({ inline: "nearest", block: "nearest" });
					}),
				);
			});
			menu.showAtMouseEvent(e);
		});
	}
	const groupCopy: CopyControl = {
		kind: "tabs",
		label: "Copy tab group contents",
		notice: "Tab group copied.",
		path,
		target: { nodes: [node] },
	};
	if (ctx.editable) {
		const grip = iconButton(sticky, "mica-group-grip", "grip-vertical", "Drag to move this tab group");
		makeDraggable(
			grip,
			{ kind: "group", fromPath: path, text: serializeCst({ children: [node] }) },
			path,
			(op) => ctx.editable?.apply(op),
			wrap,
		);
	}
	entityMenu(
		sticky,
		ctx,
		() => {
			const actions: ActionSpec[] = [copyAction(ctx, groupCopy)];
			if (ctx.editable)
				actions.push(
					{
						id: "fold",
						label: "Fold this tab group",
						icon: "chevrons-down-up",
						run: () => toggleFold(ctx, tkey),
					},
					{
						id: "delete",
						label: "Delete tab group",
						icon: "trash-2",
						danger: true,
						separatorBefore: true,
						run: () => deleteWithUndo(ctx, { op: "deleteNode", path }, "Tab group deleted"),
					},
				);
			return actions;
		},
		"Tab group actions",
	);

	nav.addEventListener("keydown", (ev: KeyboardEvent) => {
		if (ev.target instanceof HTMLInputElement && ev.target.classList.contains("mica-rename")) return;
		if (ev.altKey) return; // Alt+arrows = reorder (handled on the chip)
		const current = btns.findIndex((b) => b.tabIndex === 0);
		if (current < 0 || !btns.length) return;
		const last = btns.length - 1;
		const next =
			ev.key === "ArrowRight"
				? (current + 1) % btns.length
				: ev.key === "ArrowLeft"
					? (current + last) % btns.length
					: ev.key === "Home"
						? 0
						: ev.key === "End"
							? last
							: -1;
		if (next < 0) return;
		ev.preventDefault();
		activate(next, true);
	});

	if (btns.length) activate(active, revealTab >= 0);
}

function tabActions(
	ctx: RenderCtx,
	path: number[],
	idx: number,
	display: string,
	originalTitle: string,
	chip: HTMLElement,
	button: HTMLElement,
	copy: CopyControl,
): ActionSpec[] {
	const actions: ActionSpec[] = [copyAction(ctx, copy)];
	if (!ctx.editable) return actions;
	actions.push(
		{
			id: "rename",
			label: "Rename",
			icon: "pencil",
			run: () => startRename(chip, button, ctx, path, idx, display, originalTitle),
		},
		{
			id: "icon",
			label: "Set icon…",
			icon: "smile",
			run: () => {
				const picker = openIconPicker({
					app: ctx.app,
					title: `Choose an icon for ${display || `Tab ${idx + 1}`}`,
					// Only packs the user turned on; an empty list keeps the
					// picker to Obsidian's built-in icons and makes no requests.
					enabledPacks: ctx.chip?.plugin.settings.enabledIconPacks ?? [],
					current: titleAttr(originalTitle, "icon"),
					onChoose: (value) =>
						ctx.editable?.apply({ op: "setTabAttr", path, index: idx, key: "icon", value }),
				});
				ctx.component.register(() => picker.close());
			},
		},
		{
			id: "duplicate",
			label: "Duplicate",
			icon: "copy-plus",
			run: () => ctx.editable?.apply({ op: "duplicateNode", path: [...path, idx] }),
		},
		{
			id: "delete",
			label: "Delete",
			icon: "trash-2",
			danger: true,
			separatorBefore: true,
			run: () => deleteWithUndo(ctx, { op: "deleteTab", path, index: idx }, "Tab deleted"),
		},
	);
	return actions;
}

function startRename(
	chip: HTMLElement,
	btn: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	index: number,
	display: string,
	_fullTitle: string,
	resume = false,
): void {
	if (chip.querySelector(".mica-rename")) return;
	const pathKey = path.join(".");
	if (ctx.ui && !resume) {
		ctx.ui.tabRename = { path: pathKey, index, display, value: display };
	}
	const pending = ctx.ui?.tabRename;
	btn.style.display = "none";
	const input = chip.createEl("input", { cls: "mica-rename", attr: { type: "text" } });
	input.value = pending?.path === pathKey && pending.index === index ? pending.value : display;
	input.focus();
	input.select();
	let done = false;
	let composing = false;
	const stop = (): void => {
		document.removeEventListener("pointerdown", onOutside, true);
		input.removeEventListener("blur", commit);
		input.removeEventListener("compositionstart", onCompositionStart);
		input.removeEventListener("compositionend", onCompositionEnd);
	};
	const close = (endSession = true): void => {
		if (endSession && ctx.ui?.tabRename?.path === pathKey && ctx.ui.tabRename.index === index)
			ctx.ui.tabRename = undefined;
		input.remove();
		btn.style.display = "";
	};
	const commit = (): void => {
		if (done) return;
		done = true;
		stop();
		const title = input.value.trim() || "Tab";
		close();
		if (title === (display || "Tab")) return;
		ctx.editable?.apply({ op: "renameTab", path, index, title });
	};
	const cancel = (): void => {
		if (done) return;
		done = true;
		stop();
		close();
	};
	// Clicking a non-focusable surface never fires blur — commit explicitly.
	const onOutside = (ev: PointerEvent): void => {
		if (ev.target !== input) commit();
	};
	const onCompositionStart = (): void => {
		composing = true;
	};
	const onCompositionEnd = (): void => {
		composing = false;
	};
	const detachForRender = (): void => {
		if (done) return;
		done = true;
		stop();
		close(false);
		// A normal widget replacement resumes synchronously from BlockUi. If no
		// replacement appears, discard the provisional session instead of
		// reopening it after an editor/view lifecycle change.
		let attempts = 0;
		const expireIfOrphaned = (): void => {
			const active = ctx.ui?.tabRename;
			if (active?.path !== pathKey || active.index !== index) return;
			if (document.querySelector(".mica-tab-chip .mica-rename")) return;
			if (++attempts < 120) {
				requestAnimationFrame(expireIfOrphaned);
				return;
			}
			ctx.ui!.tabRename = undefined;
		};
		requestAnimationFrame(expireIfOrphaned);
	};
	ctx.component.register(detachForRender);
	document.addEventListener("pointerdown", onOutside, true);
	input.addEventListener("input", () => {
		const active = ctx.ui?.tabRename;
		if (active?.path === pathKey && active.index === index) active.value = input.value;
	});
	input.addEventListener("compositionstart", onCompositionStart);
	input.addEventListener("compositionend", onCompositionEnd);
	input.addEventListener("keydown", (e) => {
		// The temporary text field owns its navigation keys. In particular,
		// Left/Right/Home/End must move the caret rather than bubbling to the
		// tablist's roving-focus handler.
		e.stopPropagation();
		if (e.key === "Enter" && !composing && !e.isComposing) {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancel();
		}
	});
	input.addEventListener("blur", commit);
}

/**
 * Draggable dividers between grid columns. Dragging rebalances the two
 * adjacent columns' fr fractions live; release persists `colw` into the
 * grid's header via the shared reducer (double-click resets to equal).
 */
/** Write the grid's row template: per-row MIN heights, `null` = content. */
function applyRowTemplate(grid: HTMLElement, rows: (number | null)[]): void {
	if (rows.some((h) => h !== null)) {
		grid.style.gridTemplateRows = rows.map((h) => (h ? `minmax(${h}px, auto)` : "auto")).join(" ");
	} else {
		grid.style.removeProperty("grid-template-rows");
	}
}

/** Serialize row heights for the header attr (trailing autos trimmed). */
function rowhValue(rows: (number | null)[]): string | null {
	const trimmed = [...rows];
	while (trimmed.length && trimmed[trimmed.length - 1] === null) trimmed.pop();
	if (!trimmed.length) return null;
	return trimmed.map((h) => (h === null ? "auto" : String(h))).join(",");
}

function mountGridResizers(
	grid: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	cols: number,
	widths: number[],
	rowHeights: (number | null)[],
): void {
	const strips: HTMLElement[] = [];
	const rowStrips: HTMLElement[] = [];
	// The direct cells are fixed for this mount — any structural change
	// re-renders the whole block — so query once, not per layout pass.
	const cells = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .mica-cell"));
	const rowCount = Math.ceil(cells.length / cols);
	let layoutHandles: () => void = () => {};
	const layout = (): void => {
		if (!grid.isConnected) return;
		layoutHandles();
		const g = grid.getBoundingClientRect();
		// Roll the rect reads: boundary b shares cells[b] with boundary b+1.
		let right = cells[0]?.getBoundingClientRect();
		for (let b = 1; b < cols; b++) {
			const strip = strips[b - 1];
			const left = right;
			right = cells[b]?.getBoundingClientRect();
			if (!left || !right || right.left <= left.right - 1) {
				strip.style.display = "none"; // boundary has no cells yet
				continue;
			}
			strip.style.display = "";
			strip.style.left = `${(left.right + right.left) / 2 - g.left - 4}px`;
		}
		// Row boundaries: the first cell of each row carries the row's box.
		for (let r = 0; r + 1 < rowCount; r++) {
			const strip = rowStrips[r];
			const above = cells[r * cols]?.getBoundingClientRect();
			const below = cells[(r + 1) * cols]?.getBoundingClientRect();
			if (!above || !below || below.top <= above.bottom - 1) {
				strip.style.display = "none";
				continue;
			}
			strip.style.display = "";
			strip.style.top = `${(above.bottom + below.top) / 2 - g.top - 4}px`;
		}
	};
	const live = (w: number[]): void => {
		grid.style.gridTemplateColumns = w.map((x) => `minmax(0, ${x.toFixed(3)}fr)`).join(" ");
	};

	// The ⊕ pill is the ONE click-to-add target; the strip itself only ever
	// resizes (drag) or resets (double-click) — a bare strip click did both
	// jobs before and the first click of a double-click inserted a column.
	// Activation is pointer-captured with a movement tolerance: a native
	// click dies when the pointer drifts a few pixels between down and up,
	// which read as "the button just didn't trigger".
	const plusPill = (strip: HTMLElement, tip: string, run: () => void): void => {
		const pill = iconButton(strip, "mica-boundary-plus", "plus", tip);
		// Pointer-gesture activation: capture keeps the pointerup on the pill
		// so a few pixels of drift still count as a click (a native click
		// dies on any drift — "the button just didn't trigger"), while >8px
		// is a deliberate move and does nothing. The click handler is only
		// the programmatic fallback (a real gesture already ran or was a
		// drift-reject; either way the click must not double-fire).
		let pointerGesture = false;
		let ran = false;
		pill.addEventListener("click", (e) => {
			e.stopPropagation(); // edge strips also listen for click
			if (!pointerGesture && !ran) run();
			pointerGesture = false;
			ran = false;
		});
		pill.addEventListener("pointerdown", (e) => {
			pointerGesture = true;
			ran = false;
			e.stopPropagation(); // never arm the strip's resize
			e.preventDefault();
			try {
				pill.setPointerCapture(e.pointerId);
			} catch {
				// Synthetic events carry no active pointer — capture is moot.
			}
			const sx = e.clientX;
			const sy = e.clientY;
			const up = (ue: PointerEvent): void => {
				pill.removeEventListener("pointerup", up);
				if (Math.hypot(ue.clientX - sx, ue.clientY - sy) <= 8) {
					ran = true;
					run();
				}
			};
			pill.addEventListener("pointerup", up);
		});
	};

	for (let b = 1; b < cols && cells.length > 1; b++) {
		const strip = grid.createDiv({ cls: "mica-col-resizer" });
		strip.createDiv({ cls: "mica-col-resizer-line" });
		strip.setAttribute("aria-label", "Drag: resize · double-click: reset widths · ⊕/right-click: new column");
		plusPill(strip, "New column here", () => ctx.editable?.apply({ op: "insertColumn", path, at: b }));
		strips.push(strip);
		const resetPair = (): void => {
			// Reset ONLY this pair: both take their average share; if that makes
			// every column equal again, drop the attr entirely.
			const w = [...widths];
			const avg = (w[b - 1] + w[b]) / 2;
			w[b - 1] = avg;
			w[b] = avg;
			const rounded = w.map((x) => Math.round(x * 100) / 100);
			const uniform = rounded.every((x) => Math.abs(x - rounded[0]) < 0.03);
			ctx.editable?.apply({
				op: "setGroupAttr",
				path,
				key: "colw",
				value: uniform ? null : rounded.join(","),
			});
		};
		strip.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			resetPair();
		});
		strip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = ownMenu(ctx, new Menu());
			menu.addItem((i) =>
				i
					.setTitle("New column here")
					.setIcon("plus")
					.onClick(() => ctx.editable?.apply({ op: "insertColumn", path, at: b })),
			);
			menu.addItem((i) => i.setTitle("Reset this pair's widths").setIcon("undo-2").onClick(resetPair));
			menu.addItem((i) =>
				i
					.setTitle("Distribute all widths evenly")
					.setIcon("columns-3")
					.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "colw", value: null })),
			);
			menu.showAtMouseEvent(e);
		});
		strip.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			down.stopPropagation();
			const startX = down.clientX;
			const startW = [...widths];
			const total = startW.reduce((a, x) => a + x, 0);
			const frPerPx = total / Math.max(1, grid.clientWidth);
			let lastW = startW;
			const move = (e: PointerEvent): void => {
				document.body.addClass("mica-handle-dragging"); // one gesture, one visual
				// Clamp so neither neighbour shrinks below 0.15fr.
				const raw = (e.clientX - startX) * frPerPx;
				const dFr = Math.max(-(startW[b - 1] - 0.15), Math.min(startW[b] - 0.15, raw));
				const w = [...startW];
				w[b - 1] = startW[b - 1] + dFr;
				w[b] = startW[b] - dFr;
				lastW = w;
				live(w);
				layout();
			};
			const onEsc = (ke: KeyboardEvent): void => {
				if (ke.key !== "Escape") return;
				ke.preventDefault();
				ke.stopPropagation();
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				live(startW);
				layout();
			};
			window.addEventListener("keydown", onEsc, true);
			const up = (e: PointerEvent): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				const moved = Math.abs(e.clientX - startX) >= 5;
				if (e.type !== "pointerup" || !moved) {
					live(startW); // sub-threshold wiggle: snap back, commit nothing
					layout();
					return;
				}
				widths.splice(0, widths.length, ...lastW);
				const rounded = lastW.map((x) => Math.round(x * 100) / 100);
				const uniform = rounded.every((x) => Math.abs(x - rounded[0]) < 0.03);
				ctx.editable?.apply({
					op: "setGroupAttr",
					path,
					key: "colw",
					value: uniform ? null : rounded.join(","),
				});
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", up, true);
		});
	}
	// Row dividers: dragging sets the UPPER row's minimum height in px.
	for (let r = 0; r + 1 < rowCount; r++) {
		const strip = grid.createDiv({ cls: "mica-row-resizer" });
		strip.createDiv({ cls: "mica-row-resizer-line" });
		strip.setAttribute("aria-label", "Drag: resize · double-click: reset heights · ⊕/right-click: new row");
		plusPill(strip, "New row here", () => ctx.editable?.apply({ op: "insertRow", path, atRow: r + 1 }));
		rowStrips.push(strip);
		const resetRowPair = (): void => {
			rowHeights[r] = null;
			rowHeights[r + 1] = null;
			ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: rowhValue(rowHeights) });
		};
		strip.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			resetRowPair();
		});
		strip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = ownMenu(ctx, new Menu());
			menu.addItem((i) =>
				i
					.setTitle("New row here")
					.setIcon("plus")
					.onClick(() => ctx.editable?.apply({ op: "insertRow", path, atRow: r + 1 })),
			);
			menu.addItem((i) => i.setTitle("Reset this pair's heights").setIcon("undo-2").onClick(resetRowPair));
			menu.addItem((i) =>
				i
					.setTitle("Distribute all heights evenly")
					.setIcon("rows-3")
					.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: null })),
			);
			menu.showAtMouseEvent(e);
		});
		strip.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			down.stopPropagation();
			const startY = down.clientY;
			// The divider moves BETWEEN the pair: the upper row takes what the
			// lower gives (each floors at 40px / its content height).
			const measured = (row: number): number =>
				Math.round(cells[row * cols]?.getBoundingClientRect().height ?? 80);
			const startA = rowHeights[r] ?? measured(r);
			const startB = rowHeights[r + 1] ?? measured(r + 1);
			let lastA: number | null = null;
			let lastB: number | null = null;
			const move = (e: PointerEvent): void => {
				document.body.addClass("mica-handle-dragging");
				const dy = e.clientY - startY;
				lastA = Math.max(40, Math.round(startA + dy));
				lastB = Math.max(40, Math.round(startB - dy));
				const live = [...rowHeights];
				live[r] = lastA;
				live[r + 1] = lastB;
				applyRowTemplate(grid, live);
				layout();
			};
			const onEsc = (ke: KeyboardEvent): void => {
				if (ke.key !== "Escape") return;
				ke.preventDefault();
				ke.stopPropagation();
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				applyRowTemplate(grid, rowHeights);
				layout();
			};
			window.addEventListener("keydown", onEsc, true);
			const up = (e: PointerEvent): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				const movedRow = Math.abs(e.clientY - startY) >= 5;
				if (e.type !== "pointerup" || lastA === null || !movedRow) {
					applyRowTemplate(grid, rowHeights); // wiggle: snap back
					layout();
					return;
				}
				rowHeights[r] = lastA;
				rowHeights[r + 1] = lastB;
				ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: rowhValue(rowHeights) });
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", up, true);
		});
	}

	// Edge strips: one-click add at the grid's four edges (no resize there,
	// so the whole strip stays clickable alongside its pill).
	const edge = (cls: string, tip: string, run: () => void): void => {
		const strip = grid.createDiv({ cls: `mica-edge-add ${cls}` });
		strip.setAttribute("aria-label", tip);
		strip.createDiv({ cls: "mica-col-resizer-line mica-edge-line" });
		plusPill(strip, tip, run);
		strip.addEventListener("click", (e) => {
			e.stopPropagation();
			run();
		});
	};
	edge("is-left", "New column on the left", () => ctx.editable?.apply({ op: "insertColumn", path, at: 0 }));
	edge("is-right", "New column on the right", () => ctx.editable?.apply({ op: "insertColumn", path, at: cols }));
	edge("is-top", "New row on top", () => ctx.editable?.apply({ op: "insertRow", path, atRow: 0 }));
	edge("is-bottom", "New row at the bottom", () => ctx.editable?.apply({ op: "insertRow", path, atRow: rowCount }));

	layoutHandles = mountGridHandles(grid, ctx, path, cols, rowCount, cells);

	// Track layout: cells resize as content changes; keep dividers glued.
	const ro = new ResizeObserver(() => layout());
	ro.observe(grid);
	// Every edit rebuilds the block into a fresh element; disconnect with the
	// component or each repaint stacks a live observer on a detached grid.
	ctx.component.register(() => ro.disconnect());
	window.requestAnimationFrame(layout);
}

/**
 * Excel-style structure handles: a slim pill at each column's top and each
 * row's left. Click opens the structural menu (insert / move / delete /
 * distribute); dragging ≥5px reorders the whole column/row with a live
 * indicator at the landing boundary; Escape cancels the drag.
 */
function mountGridHandles(
	grid: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	cols: number,
	rowCount: number,
	cells: HTMLElement[],
): () => void {
	const indicator = grid.createDiv({ cls: "mica-handle-indicator" });
	const colHandles: HTMLElement[] = [];
	const rowHandles: HTMLElement[] = [];

	const colMenu = (c: number, e: MouseEvent): void => {
		const menu = ownMenu(ctx, new Menu());
		menu.addItem((i) =>
			i
				.setTitle("Insert column left")
				.setIcon("between-vertical-end")
				.onClick(() => ctx.editable?.apply({ op: "insertColumn", path, at: c })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Insert column right")
				.setIcon("between-vertical-start")
				.onClick(() => ctx.editable?.apply({ op: "insertColumn", path, at: c + 1 })),
		);
		if (c > 0)
			menu.addItem((i) =>
				i
					.setTitle("Move left")
					.setIcon("arrow-left")
					.onClick(() => ctx.editable?.apply({ op: "moveColumn", path, from: c, to: c - 1 })),
			);
		if (c + 1 < cols)
			menu.addItem((i) =>
				i
					.setTitle("Move right")
					.setIcon("arrow-right")
					.onClick(() => ctx.editable?.apply({ op: "moveColumn", path, from: c, to: c + 1 })),
			);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Distribute widths evenly")
				.setIcon("columns-3")
				.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "colw", value: null })),
		);
		if (cols > 1)
			menu.addItem((i) =>
				i
					.setTitle("Delete column")
					.setIcon("trash-2")
					.onClick(() => deleteWithUndo(ctx, { op: "deleteColumn", path, at: c }, "Column deleted")),
			);
		menu.showAtMouseEvent(e);
	};

	const rowMenu = (r: number, e: MouseEvent): void => {
		const menu = ownMenu(ctx, new Menu());
		menu.addItem((i) =>
			i
				.setTitle("Insert row above")
				.setIcon("between-horizontal-end")
				.onClick(() => ctx.editable?.apply({ op: "insertRow", path, atRow: r })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Insert row below")
				.setIcon("between-horizontal-start")
				.onClick(() => ctx.editable?.apply({ op: "insertRow", path, atRow: r + 1 })),
		);
		if (r > 0)
			menu.addItem((i) =>
				i
					.setTitle("Move up")
					.setIcon("arrow-up")
					.onClick(() => ctx.editable?.apply({ op: "moveRow", path, from: r, to: r - 1 })),
			);
		if (r + 1 < rowCount)
			menu.addItem((i) =>
				i
					.setTitle("Move down")
					.setIcon("arrow-down")
					.onClick(() => ctx.editable?.apply({ op: "moveRow", path, from: r, to: r + 1 })),
			);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Distribute heights evenly")
				.setIcon("rows-3")
				.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: null })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Delete row")
				.setIcon("trash-2")
				.onClick(() => deleteWithUndo(ctx, { op: "deleteRow", path, atRow: r }, "Row deleted")),
		);
		menu.showAtMouseEvent(e);
	};

	// The cells of column c / row r — tinted while their handle drags so the
	// user sees WHAT is moving, not just where it lands.
	const memberCells = (axis: "x" | "y", idx: number): HTMLElement[] =>
		cells.filter((_, i) => (axis === "x" ? i % cols === idx : Math.floor(i / cols) === idx));

	/** Wire one handle: click = menu, drag ≥5px = reorder with indicator. */
	const wire = (
		handle: HTMLElement,
		from: number,
		count: number,
		axis: "x" | "y",
		menuAt: (e: MouseEvent) => void,
		commit: (to: number) => void,
		indicate: (boundary: number) => void,
	): void => {
		handle.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			menuAt(e);
		});
		handle.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			down.stopPropagation();
			const start = axis === "x" ? down.clientX : down.clientY;
			const movers = memberCells(axis, from);
			let target = from;
			let dragging = false;
			const boundaries = (): number[] => {
				// Boundary k = leading edge of slot k (slot `count` = trailing edge).
				const out: number[] = [];
				for (let k = 0; k < count; k++) {
					const el = axis === "x" ? cells[k] : cells[k * cols];
					const rect = el?.getBoundingClientRect();
					out.push(rect ? (axis === "x" ? rect.left : rect.top) : Number.POSITIVE_INFINITY);
				}
				const lastEl = axis === "x" ? cells[count - 1] : cells[(count - 1) * cols];
				const lastRect = lastEl?.getBoundingClientRect();
				out.push(lastRect ? (axis === "x" ? lastRect.right : lastRect.bottom) : Number.POSITIVE_INFINITY);
				return out;
			};
			const move = (e: PointerEvent): void => {
				const pos = axis === "x" ? e.clientX : e.clientY;
				if (!dragging && Math.abs(pos - start) < 5) return;
				dragging = true;
				document.body.addClass("mica-handle-dragging");
				handle.addClass("is-dragging");
				movers.forEach((m) => m.addClass("mica-move-source"));
				const bs = boundaries();
				// The slot whose span holds the pointer (clamped to the lattice).
				let t = count - 1;
				for (let k = 0; k < count; k++) {
					if (pos < bs[k + 1]) {
						t = k;
						break;
					}
				}
				target = t;
				indicate(t > from ? t + 1 : t);
			};
			const finish = (): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", cancel, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				handle.removeClass("is-dragging");
				movers.forEach((m) => m.removeClass("mica-move-source"));
				indicator.style.display = "none";
			};
			const onEsc = (ke: KeyboardEvent): void => {
				if (ke.key !== "Escape") return;
				ke.preventDefault();
				ke.stopPropagation();
				finish();
			};
			const cancel = (): void => finish();
			const up = (e: PointerEvent): void => {
				const wasDragging = dragging;
				finish();
				if (!wasDragging) {
					menuAt(e); // a plain click: the structural menu
					return;
				}
				if (target !== from) commit(target);
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", cancel, true);
			window.addEventListener("keydown", onEsc, true);
		});
	};

	const g = (): DOMRect => grid.getBoundingClientRect();
	for (let c = 0; c < cols; c++) {
		const handle = grid.createEl("button", {
			cls: "clickable-icon mica-col-handle",
			attr: { type: "button", "aria-label": "Column: drag to move · click for menu" },
		});
		setIcon(handle, "grip-horizontal");
		handle.setAttribute("data-col", String(c));
		colHandles.push(handle);
		wire(
			handle,
			c,
			cols,
			"x",
			(e) => colMenu(c, e),
			(to) => ctx.editable?.apply({ op: "moveColumn", path, from: c, to }),
			(b) => {
				const rect = g();
				const edgeEl = b < cols ? cells[b] : cells[cols - 1];
				const er = edgeEl?.getBoundingClientRect();
				if (!er) return;
				const x = (b < cols ? er.left : er.right) - rect.left;
				indicator.style.display = "block";
				indicator.style.left = `${x - 1.5}px`;
				indicator.style.top = "4px";
				indicator.style.width = "3px";
				indicator.style.height = `${rect.height - 8}px`;
			},
		);
	}
	for (let r = 0; r < rowCount; r++) {
		const handle = grid.createEl("button", {
			cls: "clickable-icon mica-row-handle",
			attr: { type: "button", "aria-label": "Row: drag to move · click for menu" },
		});
		setIcon(handle, "grip-vertical");
		handle.setAttribute("data-row", String(r));
		rowHandles.push(handle);
		wire(
			handle,
			r,
			rowCount,
			"y",
			(e) => rowMenu(r, e),
			(to) => ctx.editable?.apply({ op: "moveRow", path, from: r, to }),
			(b) => {
				const rect = g();
				const edgeEl = b < rowCount ? cells[b * cols] : cells[(rowCount - 1) * cols];
				const er = edgeEl?.getBoundingClientRect();
				if (!er) return;
				const y = (b < rowCount ? er.top : er.bottom) - rect.top;
				indicator.style.display = "block";
				indicator.style.top = `${y - 1.5}px`;
				indicator.style.left = "4px";
				indicator.style.height = "3px";
				indicator.style.width = `${rect.width - 8}px`;
			},
		);
	}

	// Handles ride the same layout pass as the boundary strips.
	return (): void => {
		const rect = grid.getBoundingClientRect();
		for (let c = 0; c < cols; c++) {
			const h = colHandles[c];
			const r0 = cells[c]?.getBoundingClientRect();
			if (!r0) {
				h.style.display = "none";
				continue;
			}
			h.style.display = "";
			h.style.left = `${r0.left - rect.left + r0.width / 2}px`;
			h.style.top = `${r0.top - rect.top - 2}px`;
		}
		for (let r = 0; r < rowCount; r++) {
			const h = rowHandles[r];
			const r0 = cells[r * cols]?.getBoundingClientRect();
			if (!r0) {
				h.style.display = "none";
				continue;
			}
			h.style.display = "";
			h.style.top = `${r0.top - rect.top + r0.height / 2}px`;
			h.style.left = `${r0.left - rect.left - 2}px`;
		}
	};
}

function renderGrid(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const wrap = el.createDiv({ cls: "mica-grid-wrap" });
	// Chromium can briefly lose the CSS :hover target when CodeMirror settles
	// geometry under a stationary pointer. Preserve the explicit pointer-entry
	// state until a real leave so grid chrome does not flicker or disappear.
	wrap.addEventListener("pointerenter", () => wrap.addClass("is-pointer-active"));
	wrap.addEventListener("pointerleave", () => wrap.removeClass("is-pointer-active"));
	markInspectable(wrap, ctx, `grid:${path.join(".")}`);
	wrap.setAttribute("data-mica-idx", String(path[path.length - 1] ?? 0));
	wrap.setAttribute("data-mica-node", path.join("."));
	const gkey = nodeFoldKey(path);
	if (ctx.ui?.folded.has(gkey)) {
		const cells = node.children.filter((c) => c.kind === "container" && c.name === "cell").length;
		renderFoldBar(wrap, ctx, gkey, "layout-grid", `Grid · ${cells} cell${cells === 1 ? "" : "s"}`, {
			path,
			itemEl: wrap,
			text: serializeCst({ children: [node] }),
			copy: {
				kind: "grid",
				label: "Copy grid contents",
				notice: "Grid copied.",
				path,
				target: { nodes: [node] },
			},
		});
		return;
	}
	const grid = wrap.createDiv({ cls: "mica-grid" });
	grid.setAttribute("data-mica-container", "cell");
	grid.setAttribute("data-path", path.join("."));
	grid.setAttribute("data-len", String(node.children.length));
	grid.setAttribute("data-axis", "x");
	grid.setAttribute("data-cols", String(Number(titleAttr(node.title, "cols") ?? "2") || 2));
	const cols = Number(titleAttr(node.title, "cols") ?? "2") || 2;
	grid.style.setProperty("--mica-cols", String(cols));
	// Per-column fractions (fence-persisted via the shared reducer).
	const colwRaw = (titleAttr(node.title, "colw") ?? "")
		.split(",")
		.map(Number)
		.filter((n) => Number.isFinite(n) && n > 0);
	const widths = colwRaw.length === cols ? colwRaw : new Array<number>(cols).fill(1);
	if (colwRaw.length === cols) {
		grid.style.gridTemplateColumns = widths.map((w) => `minmax(0, ${w}fr)`).join(" ");
	}
	// Per-row MIN heights ("rowh=140,auto,200"): rows can be spaced out but
	// never clip content (minmax(Xpx, auto)). NEVER emit more tracks than
	// actual rows — a stale longer list (e.g. after a column-count change)
	// would lay out phantom explicit tracks as dead space below the grid.
	const rowCount = Math.max(1, Math.ceil(node.children.length / cols));
	const rowHeights: (number | null)[] = (titleAttr(node.title, "rowh") ?? "")
		.split(",")
		.map((t) => {
			const n = Number(t);
			return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
		})
		.slice(0, rowCount);
	applyRowTemplate(grid, rowHeights);

	node.children.forEach((c, idx) => {
		if (c.kind !== "container" || c.name !== "cell") return;
		const cellPath = [...path, idx];
		const cell = grid.createDiv({ cls: "mica-cell" });
		markInspectable(cell, ctx, `cell:${cellPath.join(".")}`);
		cell.setAttribute("data-mica-idx", String(idx));
		cell.setAttribute("data-mica-node", cellPath.join("."));
		markGroupContainer(cell, cellPath, c.children.length);
		renderNodes(c.children, cell, ctx, cellPath, { autoOpen: takeRegionReveal(ctx, cellPath) });
		const bar = cell.createDiv({ cls: "mica-cell-bar" });
		if (ctx.editable) {
			const drag = iconButton(bar, "mica-cell-tool", "grip-vertical", "Drag to move this cell");
			makeDraggable(drag, "cell", cellPath, (op) => ctx.editable?.apply(op), cell);
		}
		const cellCopy: CopyControl = {
			kind: "cell",
			label: `Copy cell ${idx + 1} contents`,
			notice: "Cell copied.",
			path: cellPath,
			target: { nodes: [c] },
		};
		entityMenu(
			bar,
			ctx,
			() => {
				const actions: ActionSpec[] = [copyAction(ctx, cellCopy)];
				if (ctx.editable)
					actions.push(
						{
							id: "edit",
							label: "Edit this cell in the full editor",
							icon: "maximize-2",
							run: () =>
								openLightboxFor(ctx, {
									path: cellPath,
									start: 0,
									end: c.children.length,
									original: serializeCst({ children: c.children }),
								}),
						},
						{
							id: "clear",
							label: "Clear cell",
							icon: "eraser",
							danger: true,
							separatorBefore: true,
							run: () => deleteWithUndo(ctx, { op: "clearCell", path, index: idx }, "Cell cleared"),
						},
					);
				return actions;
			},
			`Cell ${idx + 1} actions`,
			"mica-cell-tool",
		);
	});

	const tools = wrap.createDiv({ cls: "mica-grid-tools" });
	const gridCopy: CopyControl = {
		kind: "grid",
		label: "Copy grid contents",
		notice: "Grid copied.",
		path,
		target: { nodes: [node] },
	};
	if (ctx.editable) {
		const topGrip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag to move this grid");
		topGrip.addEventListener("click", (e) => e.stopPropagation());
		makeDraggable(
			topGrip,
			{ kind: "group", fromPath: path, text: serializeCst({ children: [node] }) },
			path,
			(op) => ctx.editable?.apply(op),
			wrap,
		);
		// Grid resizers: dividers between columns (fr shares) and rows (min px).
		mountGridResizers(grid, ctx, path, cols, widths, rowHeights);

		// Ghost tile: only when the grid is EMPTY or its last row is ragged —
		// full rectangular grids grow via the boundary/edge strips instead.
		if (node.children.length === 0 || node.children.length % cols !== 0) {
			const ghost = grid.createEl("button", {
				cls: "clickable-icon mica-cell-ghost",
				attr: { type: "button", "aria-label": "Add a cell (choose its content)" },
			});
			setIcon(ghost.createSpan(), "plus");
			ghost.addEventListener("click", (e) => {
				showCellTypeMenu(ctx, path, node.children.length, e);
			});
		}

		const bar = wrap.createDiv({ cls: "mica-grid-actions" });
		const colStep = (delta: number, icon: string, label: string): void => {
			iconButton(bar, "mica-minitool mica-col-step", icon, label).addEventListener("click", (e) => {
				e.stopPropagation();
				const next = Math.max(1, Math.min(24, cols + delta));
				if (next !== cols) ctx.editable?.apply({ op: "setCols", path, cols: next });
			});
		};
		colStep(-1, "minus", "One column fewer");
		const colsBtn = bar.createEl("button", {
			cls: "mica-cols-chip",
			text: `${cols} col${cols === 1 ? "" : "s"}`,
			attr: { type: "button", "aria-label": "Change column count" },
		});
		colsBtn.addEventListener("click", () => {
			const input = bar.createEl("input", {
				cls: "mica-stepper-input",
				attr: { type: "number", min: "1", max: "24" },
			});
			bar.insertBefore(input, colsBtn);
			colsBtn.style.display = "none";
			input.value = String(cols);
			input.focus();
			input.select();
			let done = false;
			const commit = (): void => {
				if (done) return;
				done = true;
				const v = Math.max(1, Number(input.value) || cols);
				if (v !== cols) ctx.editable?.apply({ op: "setCols", path, cols: v });
				else {
					input.remove();
					colsBtn.style.display = "";
				}
			};
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") commit();
				else if (ev.key === "Escape") {
					done = true;
					input.remove();
					colsBtn.style.display = "";
				}
			});
			input.addEventListener("blur", commit);
		});
		colStep(1, "plus", "One more column");
		bar.createDiv({ cls: "mica-nav-spacer" });
	}
	entityMenu(
		tools,
		ctx,
		() => {
			const actions: ActionSpec[] = [copyAction(ctx, gridCopy)];
			if (ctx.editable)
				actions.push(
					{ id: "fold", label: "Fold this grid", icon: "chevrons-down-up", run: () => toggleFold(ctx, gkey) },
					{
						id: "delete",
						label: "Delete grid",
						icon: "trash-2",
						danger: true,
						separatorBefore: true,
						run: () => deleteWithUndo(ctx, { op: "deleteNode", path }, "Grid deleted"),
					},
				);
			return actions;
		},
		"Grid actions",
	);
}

/** Guarded structural changes that discard or regroup syntax offer one-click Undo. */
function applyWithUndo(ctx: RenderCtx, op: StructOp, what: string): boolean {
	const before = ctx.preImage?.();
	if (!before || !ctx.editable || !ctx.editable.apply(op)) return false;
	// Capture the immediate post-delete body once. Undo is accepted only while
	// that exact pre-image is still live; later edits must never be overwritten.
	const after = ctx.preImage?.();
	if (after === undefined) return true;
	const frag = document.createDocumentFragment();
	frag.appendChild(document.createTextNode(`${what}. `));
	const undo = document.createElement("button");
	undo.textContent = "Undo";
	undo.className = "mica-undo-btn";
	const notice = new Notice(frag, 8000);
	undo.addEventListener("click", () => {
		if (ctx.editable?.replaceAll(after, before)) notice.hide();
		else new Notice("Mica: Undo could not be applied because the block changed again.");
	});
	frag.appendChild(undo);
	notice.setMessage(frag);
	return true;
}

/** Destructive ops don't nag with confirms — they offer a one-click Undo. */
function deleteWithUndo(ctx: RenderCtx, op: StructOp, what: string): void {
	applyWithUndo(ctx, op, what);
}

// ---------------------------------------------------------------------------
// Footer: version chip (auto/manual lives in the chip's menu now)
// ---------------------------------------------------------------------------

interface FooterMount {
	bar: HTMLElement;
	slot: HTMLElement;
	cluster: HTMLElement;
}

function renderFooter(root: HTMLElement, ctx: RenderCtx, chip: ChipInfo): FooterMount {
	const bar = root.createDiv({ cls: "mica-footer" });
	const slot = bar.createDiv({ cls: "mica-long-footer-slot" });
	const cluster = slot.createDiv({ cls: "mica-status-cluster" });
	const p = chip.plugin;

	if (!p.settings.autoSnapshotEnabled) {
		const save = cluster.createEl("button", {
			cls: "mica-save-now",
			attr: {
				type: "button",
				"aria-label": "Snapshot the current content now (auto-save is off)",
				"data-mica-dock-action": "save",
			},
		});
		setIcon(save.createSpan({ cls: "mica-save-now-icon" }), "save");
		save.createSpan({ cls: "mica-save-now-label", text: "Save version" });
		save.addEventListener(
			"click",
			() => void saveBlockVersion(p, chip.file, chip.blockId, versionMutationBridge(chip)),
		);
	}
	if (ctx.editHistory?.canUndo() || ctx.editHistory?.canRedo()) {
		const localHistory = cluster.createDiv({
			cls: "mica-block-edit-controls",
			attr: { role: "group", "aria-label": "Block edit history" },
		});
		if (ctx.editHistory.canUndo()) {
			const undo = iconButton(
				localHistory,
				"mica-head-btn mica-block-history-undo",
				"undo-2",
				"Undo last block edit",
			);
			undo.dataset.micaDockAction = "undo";
			undo.addEventListener("click", () => ctx.editHistory?.undo());
		}
		if (ctx.editHistory.canRedo()) {
			const redo = iconButton(
				localHistory,
				"mica-head-btn mica-block-history-redo",
				"redo-2",
				"Redo last block edit",
			);
			redo.dataset.micaDockAction = "redo";
			redo.addEventListener("click", () => ctx.editHistory?.redo());
		}
	}
	const revert = iconButton(
		cluster,
		"mica-head-btn mica-revert-head",
		"rotate-ccw",
		"Revert all block changes to HEAD",
	);
	revert.dataset.micaDockAction = "revert";
	revert.dataset.micaDockAvailable = "false";
	revert.hidden = true;
	revert.addEventListener(
		"click",
		() => void revertBlockToHead(p, chip.file, chip.blockId, versionMutationBridge(chip)),
	);
	cluster.createDiv({ cls: "mica-footer-spacer" });
	if (p.settings.showVersionChip) renderVersionChip(cluster, ctx, chip, revert);
	// A full reset belongs with version history, not between Save and the
	// local Undo/Redo pair. Moving the existing node preserves its listeners
	// while keeping one command instance throughout the traveling cluster.
	cluster.appendChild(revert);
	return { bar, slot, cluster };
}

function mountLongBlockStatus(
	cst: Cst,
	root: HTMLElement,
	header: HTMLElement | null,
	footer: FooterMount,
	ctx: RenderCtx,
): void {
	const mode = ctx.longBlockControls ?? "contextual";
	const headerSlot = header?.querySelector<HTMLElement>(".mica-long-head-slot") ?? null;
	const dockHost = document.createElement("div");
	dockHost.className = "mica-long-dock-host";
	root.insertBefore(dockHost, root.querySelector(".mica-block-body"));
	// A sticky descendant of a CodeMirror block widget is vulnerable to the
	// widget's virtualized geometry and to community-theme clip/overflow rules.
	// Mount the middle dock on CodeMirror's stationary editor shell instead.
	// The actual status cluster still moves between this portal and the block's
	// own header/footer, so there is never a duplicate Save or History control.
	// `renderCst` runs from WidgetType.toDOM before CodeMirror connects `root`,
	// so the editor ancestor is intentionally resolved on the observer's first
	// placement pass rather than here.
	let editorPortal: HTMLElement | null = null;
	const dock = dockHost.createDiv({ cls: "mica-long-dock" });
	const ensureEditorPortal = (): HTMLElement | null => {
		if (editorPortal?.isConnected) return editorPortal;
		const editor = root.closest<HTMLElement>(".cm-editor");
		const overlay = editor?.querySelector<HTMLElement>(":scope > .mica-live-long-dock-overlay");
		if (!overlay) return null;
		editorPortal?.remove();
		editorPortal = overlay.createDiv({ cls: "mica-live-long-dock-portal" });
		editorPortal.dataset.micaLongFor =
			ctx.chip?.blockId ?? root.dataset.micaSourceStart ?? root.dataset.micaBlockId ?? "";
		const accent = getComputedStyle(root).getPropertyValue("--mica-accent");
		if (accent) editorPortal.style.setProperty("--mica-accent", accent);
		editorPortal.appendChild(dock);
		return editorPortal;
	};
	ctx.component.register(() => editorPortal?.remove());
	const committedSource = (): string => ctx.preImage?.() ?? serializeCst(cst);
	const currentSource = (): string => {
		const draft = ctx.ui?.draft;
		const overlay: DockDraftOverlay | null =
			draft?.path && draft.start !== undefined && draft.end !== undefined
				? {
						path: draft.path,
						start: draft.start,
						end: draft.end,
						expected: draft.expected,
						text: draft.text,
					}
				: null;
		return sourceWithDraft(committedSource(), overlay);
	};
	const initial = buildDockRuntimeSource(currentSource());
	const controller = new DockTargetController(
		initial.index,
		initial.cst,
		() => ctx.dockCopyTargetMode ?? "contextual",
		ctx.ui
			? {
					get: () => ctx.ui?.dockPinnedScope,
					set: (locator) => {
						if (ctx.ui) ctx.ui.dockPinnedScope = locator;
					},
				}
			: undefined,
	);
	const copyResolved = (wholeBlock = false): void => {
		const source = currentSource();
		let runtime;
		try {
			runtime = buildDockRuntimeSource(source);
		} catch {
			new Notice("Mica: this block could not be parsed for copying.");
			return;
		}
		const scope = wholeBlock ? runtime.index.byKey.get("block:") : controller.resolveIn(runtime.index)?.scope;
		if (!scope) {
			new Notice("Mica: the selected copy scope changed or became ambiguous. Choose it again.");
			return;
		}
		const target = copyTargetForScope(runtime.cst, runtime.source, scope);
		if (!target) {
			new Notice("Mica: the selected copy scope is stale. Choose it again.");
			return;
		}
		const described = controller.describe(scope);
		writeClipboardProjection(
			target,
			ctx.copyOptions?.() ?? DEFAULT_COPY_OPTIONS,
			`${wholeBlock ? "Whole block" : described.label} copied.`,
		);
	};
	const travel = document.createElement("div");
	travel.className = "mica-long-travel";
	const name = travel.createSpan({
		cls: "mica-long-dock-name",
		text: displayBlockName(
			ctx.blockAttrs?.["name"] ?? "",
			ctx.blockNamePresentation ?? {
				noteBasename: "",
				unnamedOrdinal: 1,
			},
		),
	});
	name.setAttribute("title", name.textContent ?? "");
	const scopeGroup = travel.createDiv({ cls: "mica-long-copy-scope" });
	scopeGroup.dataset.micaDockGroup = "copy";
	const copy = iconButton(scopeGroup, "mica-head-btn mica-long-copy", "copy", "Copy current scope");
	copy.dataset.micaDockAction = "copy";
	copy.addEventListener("click", (event) => {
		event.stopPropagation();
		copyResolved();
	});
	const scope = scopeGroup.createEl("button", {
		cls: "clickable-icon mica-long-scope",
		attr: { type: "button", "aria-label": "Choose clipboard scope" },
	});
	scope.createSpan({ cls: "mica-long-scope-text" });
	setIcon(scope.createSpan({ cls: "mica-long-scope-chevron" }), "chevron-down");
	scope.addEventListener("click", (event) => {
		event.stopPropagation();
		new DockScopePicker(ctx.app, controller, () => copyResolved(true)).open();
	});
	const unsubscribeTarget = controller.subscribe((target) => {
		const reason =
			target.reason === "automatic"
				? "Automatic"
				: target.reason === "focused"
					? "Focused"
					: target.reason === "pinned"
						? "Pinned"
						: target.reason === "manual"
							? "Manual"
							: "Whole block";
		const compact = compactDockTargetLabel(target);
		const description = dockCopyTargetDescription(target);
		scope.querySelector<HTMLElement>(".mica-long-scope-text")?.setText(compact);
		scope.setAttribute("aria-label", `Change copy target. ${reason}: ${description}`);
		scope.title = `${reason} copy target · ${target.breadcrumb.join(" › ")}`;
		copy.setAttribute("aria-label", `Copy ${description}`);
		copy.title = `Copy ${target.breadcrumb.join(" › ")}`;
		scopeGroup.dataset.micaDockTargetReason = target.reason;
		scopeGroup.dataset.micaDockTargetKind = target.scope.kind;
	});
	ctx.component.register(unsubscribeTarget);
	travel.appendChild(footer.cluster);
	const jumps = travel.createDiv({ cls: "mica-long-jumps" });
	const top = iconButton(jumps, "mica-head-btn mica-long-jump is-top", "arrow-up-to-line", "Jump to top of block");
	top.dataset.micaDockAction = "jump-top";
	const bottom = iconButton(
		jumps,
		"mica-head-btn mica-long-jump is-bottom",
		"arrow-down-to-line",
		"Jump to bottom of block",
	);
	bottom.dataset.micaDockAction = "jump-bottom";
	top.addEventListener("click", () => scrollLongBlock(root, "top"));
	bottom.addEventListener("click", () => scrollLongBlock(root, "bottom"));
	footer.slot.appendChild(travel);

	const jumpOnly = dock.createDiv({ cls: "mica-long-travel is-jumps-only" });
	const jumpOnlyGroup = jumpOnly.createDiv({ cls: "mica-long-jumps" });
	const jumpOnlyTop = iconButton(
		jumpOnlyGroup,
		"mica-head-btn mica-long-jump is-top",
		"arrow-up-to-line",
		"Jump to top of block",
	);
	jumpOnlyTop.dataset.micaDockAction = "jump-top";
	const jumpOnlyBottom = iconButton(
		jumpOnlyGroup,
		"mica-head-btn mica-long-jump is-bottom",
		"arrow-down-to-line",
		"Jump to bottom of block",
	);
	jumpOnlyBottom.dataset.micaDockAction = "jump-bottom";
	jumpOnlyTop.addEventListener("click", () => scrollLongBlock(root, "top"));
	jumpOnlyBottom.addEventListener("click", () => scrollLongBlock(root, "bottom"));

	const layout = new Set(ctx.dockActionLayout ?? DEFAULT_DOCK_ACTION_LAYOUT);
	const optionalActions = new Map<DockActionId, HTMLElement>();
	for (const element of travel.querySelectorAll<HTMLElement>("[data-mica-dock-action]")) {
		const id = element.dataset.micaDockAction as DockActionId | undefined;
		if (id) optionalActions.set(id, element);
	}
	optionalActions.set("copy", scopeGroup);
	if (layout.has("navigator")) {
		const navigator = iconButton(footer.cluster, "mica-head-btn", "list-tree", "Object navigator");
		navigator.dataset.micaDockAction = "navigator";
		navigator.addEventListener("click", () => openNavigator(cst, root, ctx));
		optionalActions.set("navigator", navigator);
	}
	if (layout.has("appearance") && ctx.editable) {
		const appearance = iconButton(footer.cluster, "mica-head-btn", "palette", "Block appearance");
		appearance.dataset.micaDockAction = "appearance";
		appearance.addEventListener("click", () => openAppearance(root, ctx));
		optionalActions.set("appearance", appearance);
	}
	const responsiveHost = document.createElement("div");
	responsiveHost.className = "mica-long-responsive-host";
	travel.insertBefore(responsiveHost, jumps);
	const responsiveActions = mountResponsiveActionStrip(
		responsiveHost,
		() =>
			(ctx.dockActionLayout ?? DEFAULT_DOCK_ACTION_LAYOUT)
				.filter((id) => id !== "copy" && id !== "history")
				.map((id, index): ActionSpec | null => {
					const element = optionalActions.get(id);
					const definition = DOCK_ACTION_OPTIONS.find((option) => option.id === id);
					if (!element || !definition || element.dataset.micaDockAvailable === "false") return null;
					return {
						id,
						label: element.getAttribute("aria-label") ?? definition.label,
						icon: definition.icon,
						directPriority: Math.min(4, index) as 0 | 1 | 2 | 3 | 4,
						danger: id === "revert",
						disabled: element instanceof HTMLButtonElement ? element.disabled : false,
						run: () => element.click(),
					};
				})
				.filter((action): action is ActionSpec => action !== null),
		{
			app: ctx.app,
			source: root,
			label: "Traveling dock actions",
			className: "mica-long-responsive-actions",
			buttonClass: "mica-head-btn",
			menuClass: "mica-head-btn",
			reservedWidth: () =>
				Math.min(
					root.clientWidth,
					(name.offsetWidth || 0) +
						(scopeGroup.hidden ? 0 : scopeGroup.offsetWidth || 0) +
						(optionalActions.get("history")?.offsetWidth || 0) +
						32,
				),
		},
	);
	ctx.component.register(responsiveActions.destroy);
	const refreshResponsiveActions = (): void => responsiveActions.refresh();
	root.addEventListener("mica-dock-status-change", refreshResponsiveActions);
	ctx.component.register(() => root.removeEventListener("mica-dock-status-change", refreshResponsiveActions));
	const updateAutomaticTarget = (viewport: { top: number; bottom: number; height: number }): void => {
		if ((ctx.dockCopyTargetMode ?? "contextual") !== "contextual" || ctx.ui?.dockPinnedScope) return;
		const rect = root.getBoundingClientRect();
		const x = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + rect.width / 2));
		const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, viewport.top + viewport.height * 0.35));
		const owner = document
			.elementsFromPoint(x, y)
			.map((element) => (element as HTMLElement).closest<HTMLElement>("[data-mica-dock-scope]"))
			.find((element): element is HTMLElement => Boolean(element && root.contains(element)));
		controller.setAutomatic(owner?.dataset.micaDockScope ?? "block:");
	};
	const onFocusIn = (event: FocusEvent): void => {
		const key = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-mica-dock-scope]")?.dataset
			.micaDockScope;
		controller.setFocused(key ?? null);
	};
	const onFocusOut = (): void => {
		window.setTimeout(() => {
			const active = document.activeElement as HTMLElement | null;
			if (active && root.contains(active)) return;
			controller.setFocused(null);
		}, 0);
	};
	root.addEventListener("focusin", onFocusIn);
	root.addEventListener("focusout", onFocusOut);
	ctx.component.register(() => {
		root.removeEventListener("focusin", onFocusIn);
		root.removeEventListener("focusout", onFocusOut);
	});

	const applyDockLayout = (placement: LongBlockPlacement): void => {
		const floating = placement === "middle";
		for (const [id, element] of optionalActions) {
			const allowed = layout.has(id);
			const staysDirect = id === "history";
			element.hidden = floating ? !allowed || !staysDirect : element.dataset.micaDockAvailable === "false";
		}
		for (const group of travel.querySelectorAll<HTMLElement>(".mica-block-edit-controls"))
			group.hidden =
				floating &&
				Array.from(group.querySelectorAll<HTMLElement>("[data-mica-dock-action]")).every(
					(control) => control.hidden,
				);
		responsiveHost.hidden = !floating;
		if (floating) responsiveActions.refresh();
		scopeGroup.hidden = mode !== "contextual" || placement === "short" || !layout.has("copy");
		jumpOnlyTop.hidden = !layout.has("jump-top");
		jumpOnlyBottom.hidden = !layout.has("jump-bottom");
	};
	const place = (placement: LongBlockPlacement): void => {
		const portal = ensureEditorPortal();
		root.dataset.micaLongPlacement = placement;
		root.dataset.micaLongMode = mode;
		if (portal) {
			portal.dataset.micaLongPlacement = placement;
			portal.dataset.micaLongMode = mode;
		}
		// Short blocks already have a nearby header action. The extra direct
		// copy affordance exists for the traveling contextual dock only.
		applyDockLayout(placement);
		jumpOnly.toggleClass("is-visible", mode === "jumps-only" && placement !== "short" && placement !== "bottom");
		if (mode !== "contextual" || placement === "short" || placement === "bottom") footer.slot.appendChild(travel);
		else if (placement === "top" && headerSlot) headerSlot.appendChild(travel);
		else dock.appendChild(travel);
	};
	mountLongBlockObserver(root, header, footer.bar, mode, ctx.component, place, updateAutomaticTarget);
}

function renderVersionChip(bar: HTMLElement, ctx: RenderCtx, chip: ChipInfo, revert: HTMLButtonElement): void {
	const p = chip.plugin;
	const btn = bar.createEl("button", {
		cls: "mica-chip",
		attr: { type: "button", "aria-label": "Version history", "data-mica-dock-action": "history" },
	});
	setIcon(btn.createSpan({ cls: "mica-chip-icon" }), "history");
	const count = btn.createSpan({ cls: "mica-chip-count", text: "…" });
	btn.createSpan({ cls: "mica-chip-dot" });
	btn.addEventListener("click", () => new VersionsModal(p, chip.file, chip.blockId, chip.workingCopy).open());
	let exactDirty = false;
	btn.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		const menu = ownMenu(ctx, new Menu());
		const on = p.settings.autoSnapshotEnabled;
		menu.addItem((i) =>
			i
				.setTitle(on ? "Switch to manual saving" : "Switch to auto-save")
				.setIcon(on ? "pause" : "play")
				.onClick(async () => {
					p.settings.autoSnapshotEnabled = !on;
					p.engine.resetDebouncers();
					await p.saveSettings();
				}),
		);
		if (on) {
			for (const secs of [2, 5, 10, 30]) {
				menu.addItem((i) =>
					i
						.setTitle(
							`Auto-save after ${secs}s idle${p.settings.snapshotDebounceMs === secs * 1000 ? "  ✓" : ""}`,
						)
						.onClick(async () => {
							p.settings.snapshotDebounceMs = secs * 1000;
							p.engine.resetDebouncers();
							await p.saveSettings();
						}),
				);
			}
		}
		menu.addSeparator();
		if (ctx.editHistory) {
			menu.addItem((i) =>
				i
					.setTitle(ctx.editHistory?.canUndo() ? "Undo last block edit" : "Undo unavailable")
					.setIcon("undo-2")
					.setDisabled(!ctx.editHistory?.canUndo())
					.onClick(() => ctx.editHistory?.undo()),
			);
			menu.addItem((i) =>
				i
					.setTitle(ctx.editHistory?.canRedo() ? "Redo last block edit" : "Redo unavailable")
					.setIcon("redo-2")
					.setDisabled(!ctx.editHistory?.canRedo())
					.onClick(() => ctx.editHistory?.redo()),
			);
		}
		menu.addItem((i) =>
			i
				.setTitle(exactDirty ? "Revert all block changes to HEAD" : "Block already matches HEAD")
				.setIcon("rotate-ccw")
				.setDisabled(!exactDirty)
				.onClick(() => void revertBlockToHead(p, chip.file, chip.blockId, versionMutationBridge(chip))),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Save version now")
				.setIcon("save")
				.onClick(() => void saveBlockVersion(p, chip.file, chip.blockId, versionMutationBridge(chip))),
		);
		menu.showAtMouseEvent(e);
	});

	const refresh = async (): Promise<void> => {
		try {
			const state = (await p.engine.state(chip.file))[chip.blockId];
			const n = state?.versions.length ?? 0;
			const current = await currentBlockContent(chip);
			let dirty: boolean;
			let missingObject = false;
			const currentHead = state?.rawHead ?? state?.head;
			if (currentHead) {
				const head = await readObject(p.app.vault, chip.file, currentHead);
				missingObject = head === null;
				exactDirty = !missingObject && head !== current;
				dirty = missingObject || exactDirty;
			} else {
				exactDirty = current.length > 0;
				dirty = exactDirty;
			}
			const floating = btn.closest<HTMLElement>(".mica")?.dataset.micaLongPlacement === "middle";
			revert.hidden = floating || !exactDirty;
			revert.dataset.micaDockAvailable = String(exactDirty);
			count.setText(String(n));
			btn.setAttr(
				"aria-label",
				`Version history — ${n} version${n === 1 ? "" : "s"}${
					missingObject ? ", head object missing" : dirty ? ", unsaved changes" : ""
				}. Right-click for auto-save options.`,
			);
			btn.toggleClass("is-dirty", dirty);
		} catch {
			exactDirty = false;
			revert.hidden = true;
			revert.dataset.micaDockAvailable = "false";
			count.setText("?");
			btn.setAttr("aria-label", "Version history unavailable — a history object may be missing or corrupt.");
			btn.addClass("is-dirty");
		}
		btn.closest(".mica")?.dispatchEvent(new CustomEvent("mica-dock-status-change"));
	};
	void refresh();
	let pulseTimer = 0;
	ctx.component.register(() => window.clearTimeout(pulseTimer));
	ctx.component.register(
		p.engine.onSnapshot((event) => {
			if (event.file.path !== chip.file.path) return;
			void refresh();
			if (!event.blockIds.includes(chip.blockId)) return;
			btn.addClass("mica-pulse");
			window.clearTimeout(pulseTimer);
			pulseTimer = window.setTimeout(() => btn.removeClass("mica-pulse"), 550);
		}),
	);
}

function versionMutationBridge(chip: ChipInfo): {
	workingCopy?: WorkingCopyProvider;
	recordDocuments?: (before: string, after: string, blockIds: readonly string[]) => void;
	acknowledgeExactState?: (document: string, blockIds: readonly string[], state: "done" | "undone") => boolean;
} {
	return {
		workingCopy: chip.workingCopy,
		recordDocuments: chip.recordDocuments,
		acknowledgeExactState: chip.acknowledgeExactState,
	};
}

async function currentBlockContent(chip: ChipInfo): Promise<string> {
	const doc = chip.workingCopy?.readDocument() ?? (await chip.plugin.app.vault.read(chip.file));
	if (doc === null) return chip.content;
	const matches = scanBlocksView(doc).filter((block) => block.closed && block.id === chip.blockId);
	if (matches.length !== 1) throw new Error(`Mica: block id is ambiguous or missing: ${chip.blockId}`);
	return doc.slice(matches[0].content_start, matches[0].content_end);
}

// ---------------------------------------------------------------------------

function renderMarkdown(md: string, el: HTMLElement, ctx: RenderCtx): void {
	if (!md.trim()) return;
	void MarkdownRenderer.render(
		ctx.app,
		protectLiteralAnglePlaceholders(md),
		el.createDiv({ cls: "mica-md-inner" }),
		ctx.sourcePath,
		ctx.component,
	);
}
