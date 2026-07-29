import type { Component } from "obsidian";

export type LongBlockPlacement = "short" | "top" | "middle" | "bottom";
export type LongBlockControlMode = "contextual" | "jumps-only" | "off";
export interface LongBlockViewport {
	top: number;
	bottom: number;
	height: number;
}

interface Entry {
	root: HTMLElement;
	top: HTMLElement | null;
	bottom: HTMLElement;
	mode: LongBlockControlMode;
	place: (placement: LongBlockPlacement) => void;
	last: LongBlockPlacement | null;
	owner: Manager | null;
	frameRect: DOMRect | null;
	onScrollSettled?: (viewport: LongBlockViewport) => void;
}

interface Manager {
	target: HTMLElement | Window;
	entries: Set<Entry>;
	resize: ResizeObserver | null;
	frame: number;
	fallback: number;
	settleTimer: number;
	onScroll: () => void;
}

const managers = new Map<HTMLElement | Window, Manager>();

/** Register a block with one observer/listener set shared by its scrollport. */
export function mountLongBlockObserver(
	root: HTMLElement,
	top: HTMLElement | null,
	bottom: HTMLElement,
	mode: LongBlockControlMode,
	component: Component,
	place: (placement: LongBlockPlacement) => void,
	onScrollSettled?: (viewport: LongBlockViewport) => void,
): void {
	const entry: Entry = {
		root,
		top,
		bottom,
		mode,
		place,
		last: null,
		owner: null,
		frameRect: null,
		onScrollSettled,
	};
	let connectTimer = 0;
	let connectAttempts = 0;
	let disposed = false;
	const attach = (): void => {
		connectTimer = 0;
		if (disposed) return;
		// WidgetType.toDOM returns a detached root. Resolve ownership only after
		// CodeMirror has attached it; otherwise the entry is incorrectly parked
		// on `window`, which never receives `.cm-scroller` scroll events.
		if (!root.isConnected) {
			if (++connectAttempts < 120) connectTimer = window.setTimeout(attach, 16);
			return;
		}
		const manager = managerFor(scrollTarget(root));
		entry.owner = manager;
		manager.entries.add(entry);
		manager.resize?.observe(root);
		schedule(manager);
		scheduleSettled(manager);
	};
	connectTimer = window.setTimeout(attach, 0);
	component.register(() => {
		disposed = true;
		if (connectTimer) window.clearTimeout(connectTimer);
		const owner = entry.owner;
		entry.owner = null;
		owner?.entries.delete(entry);
		owner?.resize?.unobserve(root);
		if (owner && !owner.entries.size) destroyManager(owner);
	});
}

export function scrollLongBlock(root: HTMLElement, edge: "top" | "bottom"): void {
	const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
	const target = scrollTarget(root);
	if (target instanceof HTMLElement) {
		const destination = (): number => {
			const viewport = target.getBoundingClientRect();
			const block = root.getBoundingClientRect();
			const delta = edge === "top" ? block.top - viewport.top : block.bottom - viewport.bottom;
			return Math.max(0, target.scrollTop + delta);
		};
		target.scrollTo({ top: destination(), behavior });
		target.dispatchEvent(new Event("scroll"));
		// Some Electron/community-theme combinations leave native smooth
		// scrolling suspended when a CodeMirror compositor layer changes during
		// the jump. Complete the same endpoint without animation if it did not
		// settle; this also keeps the button deterministic in background panes.
		if (behavior === "smooth")
			window.setTimeout(() => {
				if (!root.isConnected) return;
				const viewport = target.getBoundingClientRect();
				const block = root.getBoundingClientRect();
				const remaining = edge === "top" ? block.top - viewport.top : block.bottom - viewport.bottom;
				if (Math.abs(remaining) > 2) {
					target.scrollTo({ top: destination(), behavior: "auto" });
					target.dispatchEvent(new Event("scroll"));
				}
			}, 350);
		return;
	}
	root.scrollIntoView({ behavior, block: edge === "top" ? "start" : "end", inline: "nearest" });
}

function managerFor(target: HTMLElement | Window): Manager {
	const existing = managers.get(target);
	if (existing) return existing;
	const manager: Manager = {
		target,
		entries: new Set(),
		resize: null,
		frame: 0,
		fallback: 0,
		settleTimer: 0,
		onScroll: () => {
			schedule(manager);
			scheduleSettled(manager);
		},
	};
	if (typeof ResizeObserver !== "undefined") {
		manager.resize = new ResizeObserver(() => {
			schedule(manager);
			scheduleSettled(manager);
		});
		if (target instanceof HTMLElement) manager.resize.observe(target);
	}
	target.addEventListener("scroll", manager.onScroll, { passive: true });
	window.addEventListener("resize", manager.onScroll, { passive: true });
	managers.set(target, manager);
	return manager;
}

function scheduleSettled(manager: Manager): void {
	if (manager.settleTimer) window.clearTimeout(manager.settleTimer);
	manager.settleTimer = window.setTimeout(() => {
		manager.settleTimer = 0;
		const viewport = viewportRect(manager.target);
		const owner = readingBandOwner(manager, viewport);
		for (const entry of manager.entries) {
			if (entry !== owner || entry.mode === "off" || !entry.onScrollSettled) continue;
			entry.onScrollSettled(viewport);
		}
	}, 120);
}

function schedule(manager: Manager): void {
	if (manager.frame || manager.fallback) return;
	const run = (): void => {
		if (!manager.frame && !manager.fallback) return;
		if (manager.frame) window.cancelAnimationFrame(manager.frame);
		if (manager.fallback) window.clearTimeout(manager.fallback);
		manager.frame = 0;
		manager.fallback = 0;
		const viewport = viewportRect(manager.target);
		const bandOwner = readingBandOwner(manager, viewport, true);
		for (const entry of manager.entries) {
			if (!entry.root.isConnected) {
				entry.frameRect = null;
				manager.entries.delete(entry);
				manager.resize?.unobserve(entry.root);
				entry.owner = null;
				continue;
			}
			const currentTarget = scrollTarget(entry.root);
			if (currentTarget !== manager.target) {
				entry.frameRect = null;
				manager.entries.delete(entry);
				manager.resize?.unobserve(entry.root);
				const currentManager = managerFor(currentTarget);
				currentManager.entries.add(entry);
				currentManager.resize?.observe(entry.root);
				entry.owner = currentManager;
				schedule(currentManager);
				continue;
			}
			const block = entry.frameRect ?? entry.root.getBoundingClientRect();
			entry.frameRect = null;
			const long = block.height > 800 && block.height > viewport.height * 1.25;
			let placement: LongBlockPlacement;
			const intersects = block.bottom >= viewport.top && block.top <= viewport.bottom;
			if (!long || !intersects || entry.mode === "off") placement = "short";
			else {
				const top = entry.top?.getBoundingClientRect() ?? block;
				const bottom = entry.bottom.getBoundingClientRect();
				const topVisible = top.bottom >= viewport.top && top.top <= viewport.bottom;
				const bottomVisible = bottom.bottom >= viewport.top && bottom.top <= viewport.bottom;
				placement = bottomVisible ? "bottom" : topVisible ? "top" : "middle";
				if (placement === "middle" && bandOwner && entry !== bandOwner) placement = "short";
			}
			if (placement === entry.last) continue;
			entry.last = placement;
			entry.place(placement);
		}
		if (!manager.entries.size) destroyManager(manager);
	};
	// Align normal scrolling work with paint, but do not let a throttled or
	// suspended animation frame strand the controls. Obsidian can keep editor
	// panes alive while their compositor surface is temporarily inactive.
	manager.frame = window.requestAnimationFrame(run);
	manager.fallback = window.setTimeout(run, 50);
}

/** Exactly one overlapping block owns the middle floating cluster. Prefer the
 * smallest block containing the reading band, which naturally selects a
 * nested block over a broad ancestor without relying on DOM order. */
function readingBandOwner(manager: Manager, viewport: LongBlockViewport, retainFrameRects = false): Entry | null {
	const y = viewport.top + viewport.height * 0.35;
	let owner: Entry | null = null;
	let ownerHeight = Number.POSITIVE_INFINITY;
	for (const entry of manager.entries) {
		if (!entry.root.isConnected || entry.mode === "off") continue;
		const block = entry.root.getBoundingClientRect();
		if (retainFrameRects) entry.frameRect = block;
		if (block.height <= 800 || block.height <= viewport.height * 1.25) continue;
		if (block.top > y || block.bottom < y) continue;
		if (block.height >= ownerHeight) continue;
		owner = entry;
		ownerHeight = block.height;
	}
	return owner;
}

function destroyManager(manager: Manager): void {
	if (manager.frame) window.cancelAnimationFrame(manager.frame);
	if (manager.fallback) window.clearTimeout(manager.fallback);
	if (manager.settleTimer) window.clearTimeout(manager.settleTimer);
	manager.target.removeEventListener("scroll", manager.onScroll);
	window.removeEventListener("resize", manager.onScroll);
	manager.resize?.disconnect();
	managers.delete(manager.target);
}

function viewportRect(target: HTMLElement | Window): Pick<DOMRect, "top" | "bottom" | "height"> {
	if (target instanceof Window) return { top: 0, bottom: window.innerHeight, height: window.innerHeight };
	const rect = target.getBoundingClientRect();
	return { top: rect.top, bottom: rect.bottom, height: rect.height };
}

function scrollTarget(root: HTMLElement): HTMLElement | Window {
	// CodeMirror owns Live Preview scrolling. Community themes frequently add
	// overflow or clipping to embed/widget wrappers; treating one of those
	// wrappers as the scrollport leaves the dock watching an element that never
	// scrolls. Prefer the editor's real scroll DOM whenever the block is mounted
	// inside CodeMirror.
	const codeMirrorScroller = root.closest<HTMLElement>(".cm-scroller");
	if (codeMirrorScroller) return codeMirrorScroller;
	for (let element = root.parentElement; element; element = element.parentElement) {
		const style = getComputedStyle(element);
		if (/(auto|scroll|overlay)/.test(style.overflowY)) return element;
	}
	return window;
}
