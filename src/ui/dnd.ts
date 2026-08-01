import { parseCallout } from "./calloutFence";
import { parseCodeFence } from "./codeFence";
import type { StructOp } from "../cst/ops";

/**
 * Pointer-based drag & drop for tabs, cells, and whole groups — no HTML5 drag
 * events anywhere (they can't style ghosts, can't auto-scroll, and swallow
 * events inside CodeMirror widgets).
 *
 * The shell annotates the DOM it renders:
 *   - drop containers:  `data-mica-container="tab|cell|group"` + `data-path` +
 *     `data-len` (total CST child count, for the append slot);
 *   - orderable children: `data-mica-idx` (their RAW CST child index).
 *
 * A drag computes insertion slots from live geometry, shows one accent
 * indicator line, spring-loads tab chips (hover to switch panels mid-drag),
 * auto-scrolls near the viewport edges, cancels on Esc, and commits exactly
 * one move or combine operation on drop.
 */

export type DragKind = "tab" | "cell" | "group" | "region";

/** Exact reducer coordinates for one section that may participate in a
 * combine gesture. The kind is what the section holds; the core is the final
 * authority, while the UI uses the kind only to describe the operation and to
 * decide whether it needs the reducer's mixed-content permission. */
export type CombineKind = "markdown" | "callout" | "code";

export interface CombineSpec {
	path: number[];
	start: number;
	end: number;
	expected: string;
	key: CombineKind;
}

/** A merge whose parts are not all plain prose dissolves the callout or fence
 * into the merged section, so the reducer requires it to be asked for by name.
 * The bytes survive either way; what changes is whether the part stays
 * separately addressable. */
export function combineNeedsMixed(kinds: readonly CombineKind[]): boolean {
	return kinds.some((kind) => kind !== "markdown");
}

/** What a single content leaf holds. Blank text has no kind — it is scaffolding
 * between sections, and carries no say in how a merge is described. */
export function combineKindOf(text: string, isCode = false): CombineKind | null {
	if (!text.trim()) return null;
	if (isCode || parseCodeFence(text)) return "code";
	if (parseCallout(text)) return "callout";
	return "markdown";
}

/** The kind that decides how a merge is described and whether it needs the
 * reducer's mixed permission: plain only when every content leaf is prose. */
export function regionKind(kinds: readonly (CombineKind | null)[]): CombineKind | null {
	const present = kinds.filter((kind): kind is CombineKind => kind !== null);
	if (!present.length) return null;
	return present.find((kind) => kind !== "markdown") ?? "markdown";
}

/** Typed light-DOM hook installed by the renderer on first-class regions.
 * Keeping the source pre-image on the element (rather than in data attributes)
 * avoids lossy encoding and lets a drag capture all candidates once. */
export type CombineTargetElement = HTMLElement & { micaCombine?: CombineSpec };

/** What is being dragged: a node (tab/cell/group) or a leaf run (region). */
export interface DragSpec {
	kind: DragKind;
	fromPath: number[];
	/** Present for region drags: the leaf run `[start, end)` within `fromPath`. */
	region?: { start: number; end: number };
	/** Present only for first-class regions that can combine with another region. */
	combine?: CombineSpec;
	/** The dragged thing's serialization — enables CROSS-BLOCK moves (the
	 *  target block re-parses it via insertLeaf). Regions/groups only. */
	text?: string | (() => string);
	/** Virtual drags (nested callouts): the payload isn't a leaf run but a
	 *  text span INSIDE a region — dropping inserts `text` at the target and
	 *  rewrites the source region to `without` (expected-guarded). */
	virtualSplice?: {
		path: number[];
		start: number;
		end: number;
		expected: string;
		without: string | (() => string);
		/** How many CST nodes `text` parses into (same-container index shift). */
		insertCount: number | (() => number);
	};
}

interface Slot {
	parentPath: number[];
	index: number;
	/** Indicator line geometry (viewport coordinates). */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Distance reference point. */
	cx: number;
	cy: number;
	/** The owning container's bounds (pointer gating) and nesting depth. */
	container: {
		el: HTMLElement;
		rootEl: HTMLElement;
		left: number;
		top: number;
		right: number;
		bottom: number;
		depth: number;
	};
	/** Grid column metadata (cell drags): the flow indices of this column's
	 *  cells plus the same-column landing indices above/below this gap. */
	col?: { up?: number; down?: number; members: ReadonlySet<number> };
}

/** A drop container captured once per drag. Structure (elements, indices,
 *  lengths) cannot change mid-drag — ops apply only on drop and spring-loading
 *  merely toggles classes — so only rects are re-read per recompute. */
interface SlotContainer {
	el: HTMLElement;
	/** The `.mica` block root this container belongs to. */
	rootEl: HTMLElement;
	parentPath: number[];
	len: number;
	horizontal: boolean;
	depth: number;
	kids: { el: HTMLElement; idx: number }[];
	/** Live viewport bounds, refreshed only when slot geometry is recomputed. */
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** A same-block compatible target captured once when a gesture starts. Its
 * numeric bounds are refreshed only when layout can move (scroll/tab switch),
 * so pointer frames never query or rebuild the candidate DOM collection. */
interface CombineCandidate {
	el: CombineTargetElement;
	spec: CombineSpec;
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface SpringTarget {
	el: HTMLElement;
	button: HTMLElement;
	left: number;
	top: number;
	right: number;
	bottom: number;
}

type SpringBuckets = Map<number, Map<number, SpringTarget[]>>;

/** Block roots expose their op hook for cross-block drops. */
export interface CrossBlockMove {
	sourceId: string;
	sourceExpected: string;
	targetExpected: string;
	targetOp: StructOp;
	sourceOp: StructOp;
}

export type BlockApplyHost = HTMLElement & {
	micaApply?: (op: StructOp) => boolean;
	micaApplyMany?: (ops: readonly StructOp[]) => boolean;
	micaMoveAcross?: (move: CrossBlockMove) => boolean;
	micaContent?: string;
};

interface ActiveDrag {
	spec: DragSpec;
	sourceRoot: HTMLElement;
	source: HTMLElement;
	/** The dragged item's bounds at drag start — its "home". While the
	 *  pointer stays inside, NO slot is offered: a wiggle must never commit
	 *  the nearest real move just because the no-op gaps are excluded. */
	home: DOMRect;
	ghost: HTMLElement;
	indicator: HTMLElement;
	scroller: HTMLElement | null;
	containers: SlotContainer[];
	slots: Slot[];
	current: Slot | null;
	combineTargets: CombineCandidate[];
	combineArmed: CombineCandidate | null;
	combineReady: CombineCandidate | null;
	combineTimer: number | null;
	combineX: number;
	combineY: number;
	pointerX: number;
	pointerY: number;
	offsetX: number;
	offsetY: number;
	markedEl: HTMLElement | null;
	springChips: readonly SpringTarget[];
	springTargets: SpringBuckets;
	springTarget: SpringTarget | null;
	springTimer: number | null;
	scrollRaf: number | null;
	cleanup: () => void;
}

let active: ActiveDrag | null = null;

const SPRING_LOAD_DELAY_MS = 300;
const SPRING_BUCKET_PX = 96;
const COMBINE_DWELL_MS = 650;
const COMBINE_STATIONARY_PX = 6;

const parsePath = (s: string | undefined): number[] => (s ? s.split(".").map(Number) : []);

function collectSpringChips(scope: Element): SpringTarget[] {
	const chips: SpringTarget[] = [];
	for (const el of scope.querySelectorAll<HTMLElement>(".mica-tab-chip")) {
		const button = el.querySelector<HTMLElement>(".mica-tab-btn");
		if (button) chips.push({ el, button, left: 0, top: 0, right: 0, bottom: 0 });
	}
	return chips;
}

function springTargets(chips: readonly SpringTarget[]): SpringBuckets {
	const buckets: SpringBuckets = new Map();
	for (const target of chips) {
		if (target.button.classList.contains("is-active")) continue;
		const rect = target.el.getBoundingClientRect();
		target.left = rect.left;
		target.top = rect.top;
		target.right = rect.right;
		target.bottom = rect.bottom;
		for (let y = Math.floor(rect.top / SPRING_BUCKET_PX); y <= Math.floor(rect.bottom / SPRING_BUCKET_PX); y++) {
			let row = buckets.get(y);
			if (!row) {
				row = new Map();
				buckets.set(y, row);
			}
			for (
				let x = Math.floor(rect.left / SPRING_BUCKET_PX);
				x <= Math.floor(rect.right / SPRING_BUCKET_PX);
				x++
			) {
				const entries = row.get(x) ?? [];
				entries.push(target);
				row.set(x, entries);
			}
		}
	}
	return buckets;
}

function springTargetAt(d: ActiveDrag, x: number, y: number): SpringTarget | null {
	const candidates = d.springTargets.get(Math.floor(y / SPRING_BUCKET_PX))?.get(Math.floor(x / SPRING_BUCKET_PX));
	if (!candidates) return null;
	for (const target of candidates) {
		if (x >= target.left && x <= target.right && y >= target.top && y <= target.bottom) return target;
	}
	return null;
}

/**
 * Make `handle` start a drag of the node at `path`. `itemEl` is the visual
 * element the ghost clones and dims (defaults to the handle itself).
 */
export function makeDraggable(
	handle: HTMLElement,
	spec: DragKind | DragSpec,
	path: number[],
	apply: (op: StructOp) => boolean | void,
	itemEl?: HTMLElement,
): void {
	const resolved: DragSpec = typeof spec === "string" ? { kind: spec, fromPath: path } : spec;
	handle.addClass("mica-draggable");
	handle.addEventListener("pointerdown", (down: PointerEvent) => {
		if (down.button !== 0 || down.ctrlKey || down.metaKey) return;
		const item = itemEl ?? handle;
		const startX = down.clientX;
		const startY = down.clientY;
		let started = false;

		const move = (e: PointerEvent): void => {
			if (!started) {
				if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
				started = true;
				// Suppress the click that would otherwise follow this drag.
				handle.addEventListener("click", swallowClick, { capture: true, once: true });
				beginDrag(e, resolved, item, apply);
			}
			if (active) dragMove(e);
		};
		const up = (e: PointerEvent): void => {
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
			if (active) {
				e.preventDefault();
				e.stopPropagation();
				finishDrag(e.type === "pointerup");
			}
			if (started) {
				// If no click follows (released off-element), disarm the one-shot
				// swallow so the NEXT real click isn't eaten.
				window.setTimeout(() => handle.removeEventListener("click", swallowClick, { capture: true }), 0);
			}
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	});
}

function swallowClick(e: MouseEvent): void {
	e.preventDefault();
	e.stopPropagation();
}

function beginDrag(e: PointerEvent, spec: DragSpec, item: HTMLElement, apply: (op: StructOp) => boolean | void): void {
	const root = item.closest(".mica") as HTMLElement | null;
	if (!root) return;

	const rect = item.getBoundingClientRect();
	const ghost = item.cloneNode(true) as HTMLElement;
	ghost.addClass("mica-drag-ghost");
	ghost.style.width = `${Math.min(rect.width, 360)}px`;
	document.body.appendChild(ghost);

	const indicator = document.body.createDiv({ cls: "mica-drop-indicator" });
	item.addClass("mica-dragging");
	document.body.addClass("mica-dnd-active");

	const onKey = (ke: KeyboardEvent): void => {
		if (ke.key === "Escape") {
			ke.preventDefault();
			ke.stopPropagation();
			finishDrag(false);
		}
	};
	window.addEventListener("keydown", onKey, true);

	const containers = collectContainers(root, spec);
	const combineTargets = collectCombineTargets(root, item, spec);
	const springScope = root.closest(".cm-editor, .markdown-preview-view") ?? root;
	const springChips = collectSpringChips(springScope);
	refreshCombineTargets(combineTargets);
	active = {
		spec,
		sourceRoot: root,
		source: item,
		home: rect,
		ghost,
		indicator,
		scroller: root.closest(".cm-scroller, .markdown-preview-view") as HTMLElement | null,
		containers,
		slots: computeSlots(containers, spec, root),
		current: null,
		combineTargets,
		combineArmed: null,
		combineReady: null,
		combineTimer: null,
		combineX: e.clientX,
		combineY: e.clientY,
		pointerX: e.clientX,
		pointerY: e.clientY,
		markedEl: null,
		springChips,
		springTargets: springTargets(springChips),
		offsetX: e.clientX - rect.left,
		offsetY: e.clientY - rect.top,
		springTarget: null,
		springTimer: null,
		scrollRaf: null,
		cleanup: () => {
			window.removeEventListener("keydown", onKey, true);
			ghost.remove();
			indicator.remove();
			item.removeClass("mica-combine-arming", "mica-combine-ready");
			item.removeClass("mica-dragging");
			document.body.removeClass("mica-dnd-active");
		},
	};
	// Stash the apply hook on the drag (typed loosely to keep the struct lean).
	(active as ActiveDrag & { apply?: (op: StructOp) => boolean | void }).apply = apply;
	dragMove(e);
}

/**
 * Capture the drop containers (and their orderable children) for a drag,
 * excluding the dragged node's own subtree. Queried ONCE per drag: the
 * auto-scroll loop recomputes slots every frame, and re-walking the DOM there
 * (querySelectorAll + a closest() per child) is pure waste when only the
 * geometry moves.
 */
function collectContainers(root: HTMLElement, spec: DragSpec): SlotContainer[] {
	const { kind, fromPath } = spec;
	const wanted = kind === "group" || kind === "region" ? "group" : kind;
	const fromKey = fromPath.join(".");
	const containers: SlotContainer[] = [];
	// Regions and groups can move BETWEEN blocks (their serialization rides
	// the drag) — sweep every block in the same editor pane. Numeric paths
	// collide across blocks, so subtree/no-op exclusions stay source-scoped.
	const crossable =
		Boolean(spec.text) && Boolean(root.dataset.micaBlockId) && (kind === "region" || kind === "group");
	// Virtual drags have no leaf-run subtree either.
	const scope = root.closest(".cm-editor, .markdown-preview-view");
	const roots: HTMLElement[] =
		crossable && scope
			? Array.from(scope.querySelectorAll<HTMLElement>(".mica")).filter(
					(candidate) => candidate === root || Boolean(candidate.dataset.micaBlockId),
				)
			: [root];
	for (const rootEl of roots) {
		for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>(`[data-mica-container="${wanted}"]`))) {
			if (el.closest(".mica") !== rootEl) continue; // nested block safety
			const parentPath = parsePath(el.dataset.path);
			const parentKey = parentPath.join(".");
			// Never offer slots inside the dragged node's own subtree (regions
			// are leaves — no subtree). Source block only: other blocks' paths
			// are a different coordinate space.
			if (
				rootEl === root &&
				!spec.region &&
				fromKey &&
				(parentKey === fromKey || parentKey.startsWith(`${fromKey}.`))
			)
				continue;
			// A kid belongs to THIS container only if its nearest container
			// ancestor is `el` (a region nested in a cell must never count as a
			// grid child — its idx would poison column membership).
			const kids = Array.from(el.querySelectorAll<HTMLElement>(":scope [data-mica-idx]"))
				.filter((k) => k.parentElement?.closest("[data-mica-container]") === el)
				.map((k) => ({ el: k, idx: Number(k.dataset.micaIdx ?? "0") }));
			containers.push({
				el,
				rootEl,
				parentPath,
				len: Number(el.dataset.len ?? "0"),
				horizontal: el.dataset.axis === "x",
				depth: parentPath.length,
				kids,
				left: 0,
				top: 0,
				right: 0,
				bottom: 0,
			});
		}
	}
	return containers;
}

/** Capture compatible regions from the source block only. Cross-block targets
 * remain ordinary move destinations until the multi-block combine contract is
 * deliberately defined. */
function collectCombineTargets(root: HTMLElement, source: HTMLElement, spec: DragSpec): CombineCandidate[] {
	const sourceSpec = spec.combine;
	if (!sourceSpec) return [];
	const targets: CombineCandidate[] = [];
	for (const el of Array.from(root.querySelectorAll<CombineTargetElement>(".mica-region"))) {
		if (el === source || el.closest(".mica") !== root) continue;
		const target = el.micaCombine;
		// Kinds may differ: the drop simply asks for a mixed merge, exactly as the
		// menu does. Refusing unlike kinds here is what made a callout undroppable.
		if (!target || sameCombineRegion(sourceSpec, target)) continue;
		targets.push({
			el,
			spec: { ...target, path: [...target.path] },
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
		});
	}
	return targets;
}

function sameCombineRegion(a: CombineSpec, b: CombineSpec): boolean {
	return (
		a.start === b.start &&
		a.end === b.end &&
		a.path.length === b.path.length &&
		a.path.every((part, index) => part === b.path[index])
	);
}

function refreshCombineTarget(candidate: CombineCandidate): void {
	const rect = candidate.el.getBoundingClientRect();
	candidate.left = rect.left;
	candidate.top = rect.top;
	candidate.right = rect.right;
	candidate.bottom = rect.bottom;
}

function refreshCombineTargets(candidates: readonly CombineCandidate[]): void {
	for (const candidate of candidates) refreshCombineTarget(candidate);
}

/**
 * Insertion slots for the dragged kind, from live DOM geometry.
 *
 * Slot philosophy (v2): you drop where you POINT. Slots belong to the
 * container under the pointer only — no cross-container magnetism. Grids get
 * COLUMN semantics: cells cluster into columns by geometry, and the slots are
 * the gaps of the column you're hovering, so dragging inside a column
 * reorders that column and crossing into another column is an explicit,
 * visible act. Indicators span the full gap they represent.
 */
function computeSlots(cached: SlotContainer[], spec: DragSpec, sourceRoot: HTMLElement): Slot[] {
	const { kind, fromPath } = spec;
	const slots: Slot[] = [];
	const fromKey = fromPath.join(".");
	const fromParentKey = fromPath.slice(0, -1).join(".");
	const fromIdx = fromPath[fromPath.length - 1] ?? -1;

	/** Drop the slots that would be NO-OPS — an indicator must never promise a
	 *  move that changes nothing (the gaps hugging the dragged item itself). */
	const isNoop = (s: Slot): boolean => {
		if (spec.virtualSplice) return false; // leaving the parent is always a real move
		if (s.container.rootEl !== sourceRoot) return false; // other block: never a no-op
		const pk = s.parentPath.join(".");
		if (spec.region) {
			return pk === fromKey && s.index >= spec.region.start && s.index <= spec.region.end;
		}
		if (pk !== fromParentKey) return false;
		// Same-column gaps hugging the dragged cell (column semantics).
		if (s.col?.members.has(fromIdx)) {
			return s.col.up === fromIdx || s.col.down === fromIdx;
		}
		return s.index === fromIdx || s.index === fromIdx + 1;
	};

	for (const entry of cached) {
		const { parentPath, len, kids } = entry;
		const rect = entry.el.getBoundingClientRect();
		entry.left = rect.left;
		entry.top = rect.top;
		entry.right = rect.right;
		entry.bottom = rect.bottom;
		if (rect.width === 0 || rect.height === 0) continue; // hidden panel
		const container = entry;

		if (!kids.length) {
			// Empty container: one "into" slot covering it.
			slots.push({
				parentPath,
				index: len,
				x: rect.left + 4,
				y: rect.top + 4,
				w: rect.width - 8,
				h: rect.height - 8,
				cx: rect.left + rect.width / 2,
				cy: rect.top + rect.height / 2,
				container,
			});
			continue;
		}

		if (entry.horizontal && kind === "cell") {
			// GRID: column-band semantics. Cluster cells into columns by x-centre.
			type K = { el: HTMLElement; idx: number; r: DOMRect };
			const cells: K[] = kids.map((k) => ({
				el: k.el,
				idx: k.idx,
				r: k.el.getBoundingClientRect(),
			}));
			const columns = new Map<number, K[]>();
			for (const c of cells) {
				const cx = c.r.left + c.r.width / 2;
				let key = -1;
				for (const existing of columns.keys()) {
					if (Math.abs(existing - cx) < Math.max(40, c.r.width * 0.5)) {
						key = existing;
						break;
					}
				}
				if (key < 0) key = cx;
				const list = columns.get(key) ?? [];
				list.push(c);
				columns.set(key, list);
			}
			for (const list of columns.values()) {
				list.sort((a, b) => a.r.top - b.r.top);
				let colLeft = Number.POSITIVE_INFINITY;
				let colWidth = 0;
				const members = new Set<number>();
				for (const cell of list) {
					colLeft = Math.min(colLeft, cell.r.left);
					colWidth = Math.max(colWidth, cell.r.width);
					members.add(cell.idx);
				}
				// Before each cell in the column…
				for (let i = 0; i < list.length; i++) {
					const gapTop = i === 0 ? list[i].r.top - 5 : (list[i - 1].r.bottom + list[i].r.top) / 2;
					slots.push({
						parentPath,
						index: list[i].idx,
						x: colLeft,
						y: gapTop - 1.5,
						w: colWidth,
						h: 3,
						cx: colLeft + colWidth / 2,
						cy: gapTop,
						container,
						col: { up: list[i].idx, down: i > 0 ? list[i - 1].idx : undefined, members },
					});
				}
				// …and after the last one.
				const last = list[list.length - 1];
				slots.push({
					parentPath,
					index: last.idx + 1,
					x: colLeft,
					y: last.r.bottom + 3.5,
					w: colWidth,
					h: 3,
					cx: colLeft + colWidth / 2,
					cy: last.r.bottom + 5,
					container,
					col: { down: last.idx, members },
				});
			}
			continue;
		}

		const horizontal = entry.horizontal;
		let prevEdge: number | null = null;
		for (const kid of kids) {
			const idx = kid.idx;
			const r = kid.el.getBoundingClientRect();
			if (horizontal) {
				// Centre the line in the gap between siblings, so it reads as
				// "between A and B" — never as pointing at either one.
				const gx = prevEdge === null ? r.left - 2 : (prevEdge + r.left) / 2;
				slots.push({
					parentPath,
					index: idx,
					x: gx - 1.5,
					y: r.top,
					w: 3,
					h: r.height,
					cx: gx,
					cy: r.top + r.height / 2,
					container,
				});
				prevEdge = r.right;
			} else {
				const gy = prevEdge === null ? r.top - 2 : (prevEdge + r.top) / 2;
				slots.push({
					parentPath,
					index: idx,
					x: rect.left + 4,
					y: gy - 1.5,
					w: rect.width - 8,
					h: 3,
					cx: rect.left + rect.width / 2,
					cy: gy,
					container,
				});
				prevEdge = r.bottom;
			}
		}
		// Append slot after the last child.
		const last = kids[kids.length - 1];
		const r = last.el.getBoundingClientRect();
		// A horizontally scrolling tab strip may clip the last chip. Keep the
		// append target on its visible trailing edge so a drag can still move a
		// tab to the end without pointing through the sticky group controls.
		const lastIntersectsViewport = r.right > rect.left && r.left < rect.right;
		const appendX = lastIntersectsViewport ? Math.min(r.right, rect.right - 2) : r.right;
		slots.push(
			horizontal
				? {
						parentPath,
						index: len,
						x: appendX - 1,
						y: r.top,
						w: 3,
						h: r.height,
						cx: appendX,
						cy: r.top + r.height / 2,
						container,
					}
				: (() => {
						// A stretched container (grid cell) can be much taller than
						// its content; a line hugging the content reads as "cutting
						// into the cell". Sit at the container's bottom edge instead.
						const gy = r.bottom < rect.bottom - 16 ? rect.bottom - 8 : r.bottom - 1;
						return {
							parentPath,
							index: len,
							x: rect.left + 4,
							y: gy,
							w: rect.width - 8,
							h: 3,
							cx: rect.left + rect.width / 2,
							cy: gy + 1.5,
							container,
						};
					})(),
		);
	}
	return slots.filter((s) => !isNoop(s));
}

function dragMove(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	d.pointerX = e.clientX;
	d.pointerY = e.clientY;
	d.ghost.style.transform = `translate(${e.clientX - d.offsetX}px, ${e.clientY - d.offsetY}px)`;

	// You drop where you point: only slots of containers the pointer is inside
	// (12px of forgiveness), and when containers nest, the DEEPEST one wins.
	// One pass: a deeper hit resets the running best (this fires per
	// pointermove — no throwaway candidate arrays).
	const M = 12;
	// The deepest container under the pointer — measured over ALL containers,
	// slotted or not. If IT offers no valid slot (e.g. a sole section dragged
	// within its own tab), show NOTHING rather than bubbling to an ancestor:
	// a two-pixel drag must never pop content out to the block root.
	// STRICT bounds here (no ±M): forgiveness widens where you may drop,
	// it must never widen where dropping is denied — a point just below a
	// group belongs to the parent, not to the group's body.
	let deepestUnder = -1;
	for (const c of d.containers) {
		if (c.depth <= deepestUnder) continue;
		if (
			c.right > c.left &&
			c.bottom > c.top &&
			e.clientX >= c.left &&
			e.clientX <= c.right &&
			e.clientY >= c.top &&
			e.clientY <= c.bottom
		)
			deepestUnder = c.depth;
	}
	// Home zone: inside the item's own starting bounds the drag is inert —
	// leaving the item is what expresses intent to move it.
	const home = d.home;
	const inHome =
		e.clientX >= home.left && e.clientX <= home.right && e.clientY >= home.top && e.clientY <= home.bottom;
	let best: Slot | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	let bestDepth = -1;
	if (!inHome)
		for (const s of d.slots) {
			const c = s.container;
			if (e.clientX < c.left - M || e.clientX > c.right + M || e.clientY < c.top - M || e.clientY > c.bottom + M)
				continue;
			if (c.depth < deepestUnder) continue;
			if (c.depth < bestDepth) continue;
			if (c.depth > bestDepth) {
				bestDepth = c.depth;
				best = null;
				bestDist = Number.POSITIVE_INFINITY;
			}
			const dist = Math.hypot(e.clientX - s.cx, e.clientY - s.cy);
			if (dist < bestDist) {
				best = s;
				bestDist = dist;
			}
		}
	d.current = best;

	// Tab switching and auto-scroll can move every target. Both cancel an
	// in-flight dwell; a stationary pointer must observe one stable target for
	// the complete interval before combine becomes ready.
	springLoad(e);
	const scrolling = autoScroll(e);
	updateCombineIntent(d, e.clientX, e.clientY, scrolling || d.springTarget !== null);
	paintDropIndicator(d);

	// Content drags (regions, groups): outline the receiving container so an
	// indicator INSIDE a cell can't be confused with a gap BETWEEN cells.
	// An INTO-box or combine target already outlines the destination — never both.
	const isInto = Boolean(best && best.w > 8 && best.h > 8);
	const wantMark =
		!d.combineReady && (d.spec.kind === "region" || d.spec.kind === "group") && best && !isInto
			? best.container.el
			: null;
	if (d.markedEl !== wantMark) {
		d.markedEl?.removeClass("mica-drop-inside");
		wantMark?.addClass("mica-drop-inside");
		d.markedEl = wantMark;
	}
}

/** The central part of a region is combine territory; its edge band remains a
 * conventional before/after move target. Choose the smallest containing box
 * so a future nested visual cannot steal its descendant's dwell. */
function combineCandidateAt(d: ActiveDrag, x: number, y: number): CombineCandidate | null {
	let found: CombineCandidate | null = null;
	let foundArea = Number.POSITIVE_INFINITY;
	for (const candidate of d.combineTargets) {
		if (!candidate.el.isConnected) continue;
		const width = candidate.right - candidate.left;
		const height = candidate.bottom - candidate.top;
		if (width <= 0 || height <= 0) continue;
		const insetX = Math.min(24, Math.max(6, width * 0.18));
		const insetY = Math.min(20, Math.max(6, height * 0.18));
		if (
			x < candidate.left + insetX ||
			x > candidate.right - insetX ||
			y < candidate.top + insetY ||
			y > candidate.bottom - insetY
		)
			continue;
		const area = width * height;
		if (area < foundArea) {
			found = candidate;
			foundArea = area;
		}
	}
	return found;
}

function updateCombineIntent(d: ActiveDrag, x: number, y: number, blocked: boolean): void {
	if (!d.spec.combine || blocked) {
		clearCombineIntent(d);
		return;
	}
	const candidate = combineCandidateAt(d, x, y);
	if (!candidate) {
		clearCombineIntent(d);
		return;
	}
	const same = d.combineArmed === candidate;
	const stationary = Math.hypot(x - d.combineX, y - d.combineY) <= COMBINE_STATIONARY_PX;
	if (same && stationary) return;

	clearCombineIntent(d);
	d.combineArmed = candidate;
	d.combineX = x;
	d.combineY = y;
	candidate.el.addClass("mica-combine-arming");
	d.combineTimer = window.setTimeout(() => promoteCombine(d, candidate), COMBINE_DWELL_MS);
}

function promoteCombine(d: ActiveDrag, candidate: CombineCandidate): void {
	d.combineTimer = null;
	if (active !== d || d.combineArmed !== candidate) return;
	if (d.scrollRaf !== null || d.springTarget !== null) {
		clearCombineIntent(d);
		paintDropIndicator(d);
		return;
	}
	refreshCombineTarget(candidate);
	const stillCentral = combineCandidateAt(d, d.pointerX, d.pointerY) === candidate;
	const stillStationary = Math.hypot(d.pointerX - d.combineX, d.pointerY - d.combineY) <= COMBINE_STATIONARY_PX;
	if (!d.sourceRoot.isConnected || !candidate.el.isConnected || !stillCentral || !stillStationary) {
		clearCombineIntent(d);
		paintDropIndicator(d);
		return;
	}
	candidate.el.removeClass("mica-combine-arming");
	candidate.el.addClass("mica-combine-ready");
	d.combineReady = candidate;
	paintDropIndicator(d);
	d.markedEl?.removeClass("mica-drop-inside");
	d.markedEl = null;
}

function clearCombineIntent(d: ActiveDrag): void {
	if (d.combineTimer !== null) window.clearTimeout(d.combineTimer);
	d.combineTimer = null;
	d.combineArmed?.el.removeClass("mica-combine-arming");
	d.combineReady?.el.removeClass("mica-combine-ready");
	d.combineArmed = null;
	d.combineReady = null;
	d.indicator.removeClass("is-combine-ready");
}

function paintDropIndicator(d: ActiveDrag): void {
	const ready = d.combineReady;
	if (ready) {
		d.indicator.style.display = "block";
		d.indicator.style.transform = `translate(${ready.left}px, ${ready.top}px)`;
		d.indicator.style.width = `${Math.max(0, ready.right - ready.left)}px`;
		d.indicator.style.height = `${Math.max(0, ready.bottom - ready.top)}px`;
		d.indicator.removeClass("is-into");
		d.indicator.addClass("is-combine-ready");
		return;
	}

	d.indicator.removeClass("is-combine-ready");
	const slot = d.current;
	if (!slot) {
		d.indicator.style.display = "none";
		return;
	}
	d.indicator.style.display = "block";
	d.indicator.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
	d.indicator.style.width = `${slot.w}px`;
	d.indicator.style.height = `${slot.h}px`;
	d.indicator.toggleClass("is-into", slot.w > 8 && slot.h > 8);
}

/** Hovering an inactive tab chip for the named delay activates it mid-drag. */
function springLoad(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	// Tab membership and buttons are captured at gesture start; pointer frames
	// only perform a bucket lookup against geometry refreshed after layout can
	// move. This also keeps overlapped narrow/touch chips reachable.
	const target = springTargetAt(d, e.clientX, e.clientY);
	if (target === d.springTarget) return;
	clearCombineIntent(d);
	if (d.springTimer !== null) window.clearTimeout(d.springTimer);
	d.springTimer = null;
	d.springTarget?.el.removeClass("mica-spring-pending");
	d.springTarget = target;
	if (!target) return;
	target.el.addClass("mica-spring-pending");
	d.springTimer = window.setTimeout(() => {
		target.el.removeClass("mica-spring-pending");
		if (!active || active.springTarget !== target) return;
		active.springTimer = null;
		clearCombineIntent(active);
		target.button.click();
		// The panel switch re-lays-out the block — recompute geometry.
		active.slots = computeSlots(active.containers, active.spec, active.sourceRoot);
		active.springTargets = springTargets(active.springChips);
		active.springTarget = null;
		refreshCombineTargets(active.combineTargets);
	}, SPRING_LOAD_DELAY_MS);
}

/** Scroll the note while dragging near the viewport's top/bottom edge. */
function autoScroll(e: PointerEvent): boolean {
	const d = active;
	if (!d) return false;
	const scroller = d.scroller;
	if (!scroller) return false;
	const margin = 48;
	const speed = (edgeDist: number): number => Math.ceil(((margin - edgeDist) / margin) * 14);
	let dy = 0;
	const r = scroller.getBoundingClientRect();
	if (e.clientY < r.top + margin) dy = -speed(e.clientY - r.top);
	else if (e.clientY > r.bottom - margin) dy = speed(r.bottom - e.clientY);
	if (d.scrollRaf !== null) window.cancelAnimationFrame(d.scrollRaf);
	d.scrollRaf = null;
	if (dy !== 0) {
		clearCombineIntent(d);
		const step = (): void => {
			if (active !== d) return;
			const before = scroller.scrollTop;
			scroller.scrollTop += dy;
			// Pinned at an edge: nothing moved, so the slots are already right.
			if (scroller.scrollTop === before) {
				d.scrollRaf = null;
				return;
			}
			d.slots = computeSlots(d.containers, d.spec, d.sourceRoot);
			d.springTargets = springTargets(d.springChips);
			refreshCombineTargets(d.combineTargets);
			d.scrollRaf = window.requestAnimationFrame(step);
		};
		d.scrollRaf = window.requestAnimationFrame(step);
		return true;
	}
	return false;
}

function finishDrag(commit: boolean): void {
	const d = active;
	if (!d) return;
	const combineTarget =
		commit && d.combineReady?.el.isConnected && d.sourceRoot.isConnected ? d.combineReady.spec : null;
	d.springTarget?.el.removeClass("mica-spring-pending");
	active = null;
	if (d.springTimer !== null) window.clearTimeout(d.springTimer);
	if (d.scrollRaf !== null) window.cancelAnimationFrame(d.scrollRaf);
	d.markedEl?.removeClass("mica-drop-inside");
	d.markedEl = null;
	clearCombineIntent(d);
	d.cleanup();
	if (!commit) return;
	const apply = (d as ActiveDrag & { apply?: (op: StructOp) => boolean | void }).apply;
	const combineSource = d.spec.combine;
	if (combineSource && combineTarget) {
		apply?.({
			op: "combineRegions",
			allowMixed: combineNeedsMixed([combineSource.key, combineTarget.key]),
			sourcePath: combineSource.path,
			sourceStart: combineSource.start,
			sourceEnd: combineSource.end,
			sourceExpected: combineSource.expected,
			targetPath: combineTarget.path,
			targetStart: combineTarget.start,
			targetEnd: combineTarget.end,
			targetExpected: combineTarget.expected,
		});
		return;
	}
	if (!d.current) return;
	const vs = d.spec.virtualSplice;
	const text = materialize(d.spec.text);
	if (vs && text) {
		// Nested-callout drag: insert the dedented callout at the target, then
		// rewrite the source region without it. Same-container inserts shift
		// the region's indices — adjust by the payload's parsed node count.
		const targetOp: StructOp = { op: "insertLeaf", path: d.current.parentPath, at: d.current.index, text };
		const sameContainer =
			d.current.container.rootEl === d.sourceRoot &&
			d.current.parentPath.join(".") === vs.path.join(".") &&
			d.current.index <= vs.start;
		const shift = sameContainer ? materializeNumber(vs.insertCount) : 0;
		const sourceOp: StructOp = {
			op: "saveRegion",
			path: vs.path,
			start: vs.start + shift,
			end: vs.end + shift,
			expected: vs.expected,
			text: materialize(vs.without) ?? "",
		};
		if (d.current.container.rootEl === d.sourceRoot) {
			// Same block: one reducer batch and one document transaction.
			const host = d.sourceRoot as BlockApplyHost;
			// Virtual indices may shift, so preserve the existing target-then-source order.
			host.micaApplyMany?.([targetOp, sourceOp]);
		} else {
			applyCrossBlock(d, targetOp, sourceOp);
		}
		return;
	}
	if (d.current.container.rootEl !== d.sourceRoot) {
		if (!text) return;
		const targetOp: StructOp = { op: "insertLeaf", path: d.current.parentPath, at: d.current.index, text };
		const sourceOp: StructOp = d.spec.region
			? {
					op: "saveRegion",
					path: d.spec.fromPath,
					start: d.spec.region.start,
					end: d.spec.region.end,
					expected: text,
					text: "",
				}
			: { op: "deleteNode", path: d.spec.fromPath };
		applyCrossBlock(d, targetOp, sourceOp);
		return;
	}
	if (d.spec.region) {
		apply?.({
			op: "moveRegion",
			path: d.spec.fromPath,
			start: d.spec.region.start,
			end: d.spec.region.end,
			toParent: d.current.parentPath,
			toIndex: d.current.index,
		});
		return;
	}
	const fromIdx = d.spec.fromPath[d.spec.fromPath.length - 1] ?? -1;
	const fromParent = d.spec.fromPath.slice(0, -1).join(".");
	const col = d.current.col;
	if (d.spec.kind === "cell" && col?.members.has(fromIdx) && d.current.parentPath.join(".") === fromParent) {
		// Same column: bubble within it — the other columns must not move.
		const to = col.up !== undefined && fromIdx > col.up ? col.up : col.down;
		if (to !== undefined && to !== fromIdx) {
			apply?.({ op: "moveCellInColumn", path: d.current.parentPath, from: fromIdx, to });
		}
		return;
	}
	apply?.({
		op: "moveNode",
		from: d.spec.fromPath,
		toParent: d.current.parentPath,
		toIndex: d.current.index,
	});
}

function materialize(value: string | (() => string) | undefined): string | undefined {
	return typeof value === "function" ? value() : value;
}

function materializeNumber(value: number | (() => number)): number {
	return typeof value === "function" ? value() : value;
}

/** Cross-block moves inside one editor are reduced against two fresh block
 * CSTs and dispatched together by the target widget. Stable ids and exact
 * whole-block pre-images make a stale drag reject instead of duplicate. */
function applyCrossBlock(d: ActiveDrag, targetOp: StructOp, sourceOp: StructOp): boolean {
	if (!d.current) return false;
	const source = d.sourceRoot as BlockApplyHost;
	const target = d.current.container.rootEl as BlockApplyHost;
	const sourceId = source.dataset.micaBlockId;
	if (!sourceId || !source.micaContent || !target.micaContent || !target.micaMoveAcross) return false;
	return target.micaMoveAcross({
		sourceId,
		sourceExpected: source.micaContent,
		targetExpected: target.micaContent,
		targetOp,
		sourceOp,
	});
}
