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

export type DragKind = "tab" | "cell" | "group";

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
	container: { left: number; top: number; right: number; bottom: number; depth: number };
}

interface ActiveDrag {
	kind: DragKind;
	fromPath: number[];
	source: HTMLElement;
	ghost: HTMLElement;
	indicator: HTMLElement;
	root: HTMLElement;
	slots: Slot[];
	current: Slot | null;
	offsetX: number;
	offsetY: number;
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
	kind: DragKind,
	path: number[],
	apply: (op: StructOp) => void,
	itemEl?: HTMLElement,
): void {
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
				beginDrag(e, kind, path, item, apply);
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

function beginDrag(
	e: PointerEvent,
	kind: DragKind,
	fromPath: number[],
	item: HTMLElement,
	apply: (op: StructOp) => void,
): void {
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

	active = {
		kind,
		fromPath,
		source: item,
		ghost,
		indicator,
		root,
		slots: computeSlots(root, kind, fromPath),
		current: null,
		offsetX: e.clientX - rect.left,
		offsetY: e.clientY - rect.top,
		springEl: null,
		springTimer: null,
		scrollRaf: null,
		cleanup: () => {
			window.removeEventListener("keydown", onKey, true);
			ghost.remove();
			indicator.remove();
			item.removeClass("mica-dragging");
			document.body.removeClass("mica-dnd-active");
		},
	};
	// Stash the apply hook on the drag (typed loosely to keep the struct lean).
	(active as ActiveDrag & { apply?: (op: StructOp) => void }).apply = apply;
	dragMove(e);
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
function computeSlots(root: HTMLElement, kind: DragKind, fromPath: number[]): Slot[] {
	const wanted = kind === "group" ? "group" : kind;
	const slots: Slot[] = [];
	const fromKey = fromPath.join(".");

	for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-mica-container="${wanted}"]`))) {
		const parentPath = parsePath(el.dataset.path);
		const parentKey = parentPath.join(".");
		// Never offer slots inside the dragged node's own subtree.
		if (fromKey && (parentKey === fromKey || parentKey.startsWith(`${fromKey}.`))) continue;
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue; // hidden panel
		const len = Number(el.dataset.len ?? "0");
		const kids = Array.from(el.querySelectorAll<HTMLElement>(":scope [data-mica-idx]")).filter(
			(k) => k.closest(`[data-mica-container="${wanted}"]`) === el,
		);
		const container = {
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
			depth: parentPath.length,
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

		if (el.dataset.axis === "x" && kind === "cell") {
			// GRID: column-band semantics. Cluster cells into columns by x-centre.
			type K = { el: HTMLElement; idx: number; r: DOMRect };
			const cells: K[] = kids.map((k) => ({
				el: k,
				idx: Number(k.dataset.micaIdx ?? "0"),
				r: k.getBoundingClientRect(),
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
				});
			}
			continue;
		}

		const horizontal = el.dataset.axis === "x";
		for (const kid of kids) {
			const idx = Number(kid.dataset.micaIdx ?? "0");
			const r = kid.getBoundingClientRect();
			slots.push(
				horizontal
					? {
							parentPath,
							index: idx,
							x: r.left - 2,
							y: r.top,
							w: 3,
							h: r.height,
							cx: r.left,
							cy: r.top + r.height / 2,
							container,
						}
					: {
							parentPath,
							index: idx,
							x: rect.left + 4,
							y: r.top - 2,
							w: rect.width - 8,
							h: 3,
							cx: rect.left + rect.width / 2,
							cy: r.top,
							container,
						},
			);
		}
		// Append slot after the last child.
		const last = kids[kids.length - 1];
		const r = last.getBoundingClientRect();
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
				: {
						parentPath,
						index: len,
						x: rect.left + 4,
						y: r.bottom - 1,
						w: rect.width - 8,
						h: 3,
						cx: rect.left + rect.width / 2,
						cy: r.bottom,
						container,
					},
		);
	}
	return slots;
}

function dragMove(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	d.ghost.style.transform = `translate(${e.clientX - d.offsetX}px, ${e.clientY - d.offsetY}px)`;

	// You drop where you point: only slots of containers the pointer is inside
	// (12px of forgiveness), and when containers nest, the DEEPEST one wins.
	const M = 12;
	const inside = d.slots.filter(
		(s) =>
			e.clientX >= s.container.left - M &&
			e.clientX <= s.container.right + M &&
			e.clientY >= s.container.top - M &&
			e.clientY <= s.container.bottom + M,
	);
	const maxDepth = inside.reduce((m, s) => Math.max(m, s.container.depth), -1);
	const candidates = inside.filter((s) => s.container.depth === maxDepth);
	let best: Slot | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const s of candidates) {
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

	springLoad(e);
	autoScroll(e);
}

/** Hovering an inactive tab chip for 450ms activates it mid-drag. */
function springLoad(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	const under = document.elementFromPoint(e.clientX, e.clientY);
	const chip = (under as HTMLElement | null)?.closest<HTMLElement>(".mica-tab-btn:not(.is-active)") ?? null;
	if (chip === d.springEl) return;
	if (d.springTimer !== null) window.clearTimeout(d.springTimer);
	d.springEl = chip;
	if (!chip) return;
	d.springTimer = window.setTimeout(() => {
		if (!active || active.springEl !== chip) return;
		chip.click();
		// The panel switch re-lays-out the block — recompute geometry.
		active.slots = computeSlots(active.root, active.kind, active.fromPath);
	}, 450);
}

/** Scroll the note while dragging near the viewport's top/bottom edge. */
function autoScroll(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	const scroller = d.root.closest(".cm-scroller, .markdown-preview-view") as HTMLElement | null;
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
			scroller.scrollTop += dy;
			active.slots = computeSlots(active.root, active.kind, active.fromPath);
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
	d.cleanup();
	if (!commit || !d.current) return;
	const apply = (d as ActiveDrag & { apply?: (op: StructOp) => void }).apply;
	apply?.({
		op: "moveNode",
		from: d.fromPath,
		toParent: d.current.parentPath,
		toIndex: d.current.index,
	});
}
