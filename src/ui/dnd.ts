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
 * one `moveNode` op on drop.
 */

export type DragKind = "tab" | "cell" | "group" | "region";

/** What is being dragged: a node (tab/cell/group) or a leaf run (region). */
export interface DragSpec {
	kind: DragKind;
	fromPath: number[];
	/** Present for region drags: the leaf run `[start, end)` within `fromPath`. */
	region?: { start: number; end: number };
	/** The dragged thing's serialization — enables CROSS-BLOCK moves (the
	 *  target block re-parses it via insertLeaf). Regions/groups only. */
	text?: string;
	/** Virtual drags (nested callouts): the payload isn't a leaf run but a
	 *  text span INSIDE a region — dropping inserts `text` at the target and
	 *  rewrites the source region to `without` (expected-guarded). */
	virtualSplice?: {
		path: number[];
		start: number;
		end: number;
		expected: string;
		without: string;
		/** How many CST nodes `text` parses into (same-container index shift). */
		insertCount: number;
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
	col?: { up?: number; down?: number; members: number[] };
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
}

/** Block roots expose their op hook for cross-block drops. */
export type BlockApplyHost = HTMLElement & { micaApply?: (op: StructOp) => void };

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
	offsetX: number;
	offsetY: number;
	markedEl: HTMLElement | null;
	springEl: HTMLElement | null;
	springTimer: number | null;
	scrollRaf: number | null;
	cleanup: () => void;
}

let active: ActiveDrag | null = null;

const parsePath = (s: string | undefined): number[] => (s ? s.split(".").map(Number) : []);

/**
 * Make `handle` start a drag of the node at `path`. `itemEl` is the visual
 * element the ghost clones and dims (defaults to the handle itself).
 */
export function makeDraggable(
	handle: HTMLElement,
	spec: DragKind | DragSpec,
	path: number[],
	apply: (op: StructOp) => void,
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

function beginDrag(e: PointerEvent, spec: DragSpec, item: HTMLElement, apply: (op: StructOp) => void): void {
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
		markedEl: null,
		offsetX: e.clientX - rect.left,
		offsetY: e.clientY - rect.top,
		springEl: null,
		springTimer: null,
		scrollRaf: null,
		cleanup: () => {
			window.removeEventListener("keydown", onKey, true);
			ghost.remove();
			indicator.remove();
			active?.markedEl?.removeClass("mica-drop-inside");
			document.querySelector(".mica-spring-pending")?.removeClass("mica-spring-pending");
			item.removeClass("mica-dragging");
			document.body.removeClass("mica-dnd-active");
		},
	};
	// Stash the apply hook on the drag (typed loosely to keep the struct lean).
	(active as ActiveDrag & { apply?: (op: StructOp) => void }).apply = apply;
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
	const crossable = Boolean(spec.text) && (kind === "region" || kind === "group");
	// Virtual drags have no leaf-run subtree either.
	const scope = root.closest(".cm-editor, .markdown-preview-view");
	const roots: HTMLElement[] = crossable && scope ? Array.from(scope.querySelectorAll<HTMLElement>(".mica")) : [root];
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
			});
		}
	}
	return containers;
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
		if (s.col?.members.includes(fromIdx)) {
			return s.col.up === fromIdx || s.col.down === fromIdx;
		}
		return s.index === fromIdx || s.index === fromIdx + 1;
	};

	for (const entry of cached) {
		const { parentPath, len, kids } = entry;
		const rect = entry.el.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue; // hidden panel
		const container = {
			el: entry.el,
			rootEl: entry.rootEl,
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
			depth: entry.depth,
		};

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
				const colLeft = Math.min(...list.map((c) => c.r.left));
				const colWidth = Math.max(...list.map((c) => c.r.width));
				const members = list.map((c) => c.idx);
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
		slots.push(
			horizontal
				? {
						parentPath,
						index: len,
						x: r.right - 1,
						y: r.top,
						w: 3,
						h: r.height,
						cx: r.right,
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
		const r = c.el.getBoundingClientRect();
		if (r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
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
	if (best) {
		d.indicator.style.display = "block";
		d.indicator.style.transform = `translate(${best.x}px, ${best.y}px)`;
		d.indicator.style.width = `${best.w}px`;
		d.indicator.style.height = `${best.h}px`;
		d.indicator.toggleClass("is-into", best.w > 8 && best.h > 8);
	} else {
		d.indicator.style.display = "none";
	}
	// Content drags (regions, groups): outline the receiving container so an
	// indicator INSIDE a cell can't be confused with a gap BETWEEN cells.
	// An INTO-box already outlines the container itself — never both.
	const isInto = Boolean(best && best.w > 8 && best.h > 8);
	const wantMark =
		(d.spec.kind === "region" || d.spec.kind === "group") && best && !isInto ? best.container.el : null;
	if (d.markedEl !== wantMark) {
		d.markedEl?.removeClass("mica-drop-inside");
		wantMark?.addClass("mica-drop-inside");
		d.markedEl = wantMark;
	}

	springLoad(e);
	autoScroll(e);
}

/** Hovering an inactive tab chip for 450ms activates it mid-drag. */
function springLoad(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	const under = document.elementFromPoint(e.clientX, e.clientY);
	// Match the whole chip (its button is a child, so `closest` from the chip's
	// padding or its ✕ affordance would miss a `.mica-tab-btn` selector).
	const chipWrap = (under as HTMLElement | null)?.closest<HTMLElement>(".mica-tab-chip") ?? null;
	const chip = chipWrap?.querySelector<HTMLElement>(".mica-tab-btn:not(.is-active)") ?? null;
	if (chip === d.springEl) return;
	if (d.springTimer !== null) window.clearTimeout(d.springTimer);
	document.querySelector(".mica-spring-pending")?.removeClass("mica-spring-pending");
	d.springEl = chip;
	if (!chip) return;
	chipWrap?.addClass("mica-spring-pending");
	d.springTimer = window.setTimeout(() => {
		chipWrap?.removeClass("mica-spring-pending");
		if (!active || active.springEl !== chip) return;
		chip.click();
		// The panel switch re-lays-out the block — recompute geometry.
		active.slots = computeSlots(active.containers, active.spec, active.sourceRoot);
	}, 300);
}

/** Scroll the note while dragging near the viewport's top/bottom edge. */
function autoScroll(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	const scroller = d.scroller;
	if (!scroller) return;
	const margin = 48;
	const speed = (edgeDist: number): number => Math.ceil(((margin - edgeDist) / margin) * 14);
	let dy = 0;
	const r = scroller.getBoundingClientRect();
	if (e.clientY < r.top + margin) dy = -speed(e.clientY - r.top);
	else if (e.clientY > r.bottom - margin) dy = speed(r.bottom - e.clientY);
	if (d.scrollRaf !== null) window.cancelAnimationFrame(d.scrollRaf);
	if (dy !== 0) {
		const step = (): void => {
			if (!active) return;
			const before = scroller.scrollTop;
			scroller.scrollTop += dy;
			// Pinned at an edge: nothing moved, so the slots are already right.
			if (scroller.scrollTop !== before)
				active.slots = computeSlots(active.containers, active.spec, active.sourceRoot);
			active.scrollRaf = window.requestAnimationFrame(step);
		};
		d.scrollRaf = window.requestAnimationFrame(step);
	}
}

function finishDrag(commit: boolean): void {
	const d = active;
	if (!d) return;
	active = null;
	if (d.springTimer !== null) window.clearTimeout(d.springTimer);
	if (d.scrollRaf !== null) window.cancelAnimationFrame(d.scrollRaf);
	d.markedEl?.removeClass("mica-drop-inside");
	d.markedEl = null;
	d.cleanup();
	if (!commit || !d.current) return;
	const apply = (d as ActiveDrag & { apply?: (op: StructOp) => void }).apply;
	const vs = d.spec.virtualSplice;
	if (vs && d.spec.text) {
		// Nested-callout drag: insert the dedented callout at the target, then
		// rewrite the source region without it. Same-container inserts shift
		// the region's indices — adjust by the payload's parsed node count.
		const targetApply =
			d.current.container.rootEl === d.sourceRoot
				? apply
				: (d.current.container.rootEl as BlockApplyHost).micaApply;
		if (!targetApply) return;
		targetApply({ op: "insertLeaf", path: d.current.parentPath, at: d.current.index, text: d.spec.text });
		const sameContainer =
			d.current.container.rootEl === d.sourceRoot &&
			d.current.parentPath.join(".") === vs.path.join(".") &&
			d.current.index <= vs.start;
		const shift = sameContainer ? vs.insertCount : 0;
		apply?.({
			op: "saveRegion",
			path: vs.path,
			start: vs.start + shift,
			end: vs.end + shift,
			expected: vs.expected,
			text: vs.without,
		});
		return;
	}
	if (d.current.container.rootEl !== d.sourceRoot) {
		// CROSS-BLOCK: the serialization rides the drag; the target re-parses
		// it (insertLeaf handles prose, callouts, code, and whole groups), the
		// source deletes its original. Target first — a failure duplicates,
		// never loses.
		const text = d.spec.text;
		const targetApply = (d.current.container.rootEl as BlockApplyHost).micaApply;
		if (!text || !targetApply) return;
		targetApply({ op: "insertLeaf", path: d.current.parentPath, at: d.current.index, text });
		if (d.spec.region) {
			apply?.({
				op: "saveRegion",
				path: d.spec.fromPath,
				start: d.spec.region.start,
				end: d.spec.region.end,
				expected: text,
				text: "",
			});
		} else {
			apply?.({ op: "deleteNode", path: d.spec.fromPath });
		}
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
	if (d.spec.kind === "cell" && col?.members.includes(fromIdx) && d.current.parentPath.join(".") === fromParent) {
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
