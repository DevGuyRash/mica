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

/** Insertion slots for the dragged kind, from live DOM geometry. */
function computeSlots(root: HTMLElement, kind: DragKind, fromPath: number[]): Slot[] {
	const wanted = kind === "group" ? "group" : kind;
	const slots: Slot[] = [];
	const fromKey = fromPath.join(".");

	for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-mica-container="${wanted}"]`))) {
		const parentPath = parsePath(el.dataset.path);
		const parentKey = parentPath.join(".");
		// Never offer slots inside the dragged node's own subtree.
		if (fromKey && (parentKey === fromKey || parentKey.startsWith(`${fromKey}.`))) continue;
		const len = Number(el.dataset.len ?? "0");
		const kids = Array.from(el.querySelectorAll<HTMLElement>(":scope [data-mica-idx]")).filter(
			(k) => k.closest(`[data-mica-container="${wanted}"]`) === el,
		);
		const horizontal = el.dataset.axis === "x";

		if (!kids.length) {
			// Empty container: one "into" slot covering it.
			const r = el.getBoundingClientRect();
			slots.push({
				parentPath,
				index: len,
				x: r.left + 4,
				y: r.top + 4,
				w: r.width - 8,
				h: r.height - 8,
				cx: r.left + r.width / 2,
				cy: r.top + r.height / 2,
			});
			continue;
		}
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
						}
					: {
							parentPath,
							index: idx,
							x: r.left,
							y: r.top - 2,
							w: r.width,
							h: 3,
							cx: r.left + r.width / 2,
							cy: r.top,
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
					}
				: {
						parentPath,
						index: len,
						x: r.left,
						y: r.bottom - 1,
						w: r.width,
						h: 3,
						cx: r.left + r.width / 2,
						cy: r.bottom,
					},
		);
	}
	return slots;
}

function dragMove(e: PointerEvent): void {
	const d = active;
	if (!d) return;
	d.ghost.style.transform = `translate(${e.clientX - d.offsetX}px, ${e.clientY - d.offsetY}px)`;

	// Nearest slot within reach.
	let best: Slot | null = null;
	let bestDist = 90;
	for (const s of d.slots) {
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
