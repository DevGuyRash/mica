import type { Cst, MicaNode } from "../wasm/bridge";
import type { CopyTarget } from "./copyPayload";
import type { DockCopyTargetMode } from "./dockConfig";
import {
	locatorFor,
	resolveScope,
	type ScopeIndex,
	type ScopeLocator,
	type VersionScope,
	type VersionScopeKind,
} from "./versionScopeCore";

export type DockTargetReason = "automatic" | "focused" | "pinned" | "manual" | "block";

export interface DockTargetState {
	reason: DockTargetReason;
	scope: VersionScope;
	label: string;
	breadcrumb: string[];
}

/** The dock already carries a copy icon and a complete accessible
 * description. Avoid repeating the structural kind when the useful identity
 * is the active tab title itself. Other scope kinds keep their kind because a
 * bare text/code label is otherwise ambiguous in a compact floating surface. */
export function compactDockTargetLabel(target: DockTargetState): string {
	return target.scope.kind === "tab" ? target.label.replace(/^Tab ·\s*/, "") : target.label;
}

/** Human-readable target wording shared by rendered and Source docks. */
export function dockCopyTargetDescription(target: DockTargetState): string {
	const compact = compactDockTargetLabel(target);
	return target.scope.kind === "tab" ? `tab “${compact}”` : target.label;
}

export interface DockDraftOverlay {
	path: readonly number[];
	start: number;
	end: number;
	expected: string;
	text: string;
}

export interface DockPinStore {
	get: () => ScopeLocator | undefined;
	set: (locator: ScopeLocator | undefined) => void;
}

type ChangeListener = (state: DockTargetState) => void;

/** Session controller for one block. Structural identity stays in ScopeIndex;
 * this class owns only the user's transient targeting intent. */
export class DockTargetController {
	private automaticKey = "block:";
	private focusedKey: string | null = null;
	private pinnedKey: string | null = null;
	private readonly listeners = new Set<ChangeListener>();

	constructor(
		private readonly index: ScopeIndex,
		private readonly cst: Cst,
		private readonly getMode: () => DockCopyTargetMode,
		private readonly pinStore?: DockPinStore,
	) {
		const stored = pinStore?.get();
		if (!stored) return;
		const resolved = resolveScope(index, stored);
		if (resolved.kind === "exact") this.pinnedKey = resolved.scope.key;
		else pinStore?.set(undefined);
	}

	current(): DockTargetState {
		const mode = this.getMode();
		const block = this.index.byKey.get("block:") ?? this.index.scopes[0];
		if (mode === "block") return describeTarget(this.index, this.cst, block, "block");
		if (this.pinnedKey) {
			const pinned = this.index.byKey.get(this.pinnedKey);
			if (pinned) return describeTarget(this.index, this.cst, pinned, "pinned");
		}
		if (mode === "manual") return describeTarget(this.index, this.cst, block, "manual");
		if (this.focusedKey) {
			const focused = this.index.byKey.get(this.focusedKey);
			if (focused) return describeTarget(this.index, this.cst, focused, "focused");
		}
		const automatic = this.index.byKey.get(this.automaticKey) ?? block;
		return describeTarget(this.index, this.cst, automatic, automatic.kind === "block" ? "block" : "automatic");
	}

	setAutomatic(key: string): void {
		const scope = this.index.byKey.get(key);
		if (!scope) return;
		const boundary = automaticDockBoundary(this.index, scope);
		if (boundary.key === this.automaticKey) return;
		this.automaticKey = boundary.key;
		this.emit();
	}

	setFocused(key: string | null): void {
		const next = key && this.index.byKey.has(key) ? key : null;
		if (next === this.focusedKey) return;
		this.focusedKey = next;
		this.emit();
	}

	pin(key: string): void {
		const scope = this.index.byKey.get(key);
		if (!scope) return;
		this.pinnedKey = key;
		this.pinStore?.set(locatorFor(scope, this.index));
		this.emit();
	}

	resumeAutomatic(): void {
		if (!this.pinnedKey && !this.pinStore?.get()) return;
		this.pinnedKey = null;
		this.pinStore?.set(undefined);
		this.emit();
	}

	subscribe(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		listener(this.current());
		return () => this.listeners.delete(listener);
	}

	scopes(): readonly VersionScope[] {
		return this.index.scopes;
	}

	describe(scope: VersionScope): DockTargetState {
		return describeTarget(this.index, this.cst, scope, this.current().reason);
	}

	resolveIn(index: ScopeIndex): { scope: VersionScope; reason: DockTargetReason } | null {
		const current = this.current();
		const direct = index.byKey.get(current.scope.key);
		if (direct) return { scope: direct, reason: current.reason };
		const resolved = resolveScope(index, locatorFor(current.scope, this.index));
		if (resolved.kind !== "exact") return null;
		return { scope: resolved.scope, reason: current.reason };
	}

	private emit(): void {
		const state = this.current();
		for (const listener of this.listeners) listener(state);
	}
}

/** Tabs and grids own automatic reading context. The outermost such boundary
 * wins, so a grid inside a tab remains tab-scoped and tabs inside a grid
 * remain grid-scoped until the user focuses or pins a descendant. */
export function automaticDockBoundary(index: ScopeIndex, scope: VersionScope): VersionScope {
	const ancestry: VersionScope[] = [];
	let current: VersionScope | undefined = scope;
	while (current) {
		ancestry.push(current);
		current = current.parentKey ? index.byKey.get(current.parentKey) : undefined;
	}
	ancestry.reverse();
	for (const candidate of ancestry) {
		if (candidate.kind === "tab" || candidate.kind === "grid") return candidate;
	}
	return scope;
}

/** One O(scopes) construction followed by logarithmic sibling lookup per
 * nesting level for cursor-only Source-mode transactions. */
export class DockScopeCursorIndex {
	private readonly children = new Map<string, VersionScope[]>();
	private readonly block: VersionScope;

	constructor(index: ScopeIndex) {
		this.block = index.byKey.get("block:") ?? index.scopes[0];
		for (const scope of index.scopes) {
			if (!scope.parentKey) continue;
			const siblings = this.children.get(scope.parentKey);
			if (siblings) siblings.push(scope);
			else this.children.set(scope.parentKey, [scope]);
		}
	}

	containing(from: number, to = from): VersionScope {
		let current = this.block;
		while (true) {
			const child = containingSibling(this.children.get(current.key) ?? [], from, to);
			if (!child) return current;
			current = child;
		}
	}
}

/** Convert one freshly resolved structural scope into the existing clipboard
 * projection contract. No DOM text or ancestor fallback is involved. */
export function copyTargetForScope(cst: Cst, source: string, scope: VersionScope): CopyTarget | null {
	if (scope.kind === "block") return { nodes: cst.children };
	const node = nodeAtPath(cst, scope.path);
	if (node?.kind === "container" && containerMatches(scope.kind, node.name)) return { nodes: [node] };
	if (scope.start < 0 || scope.end < scope.start || scope.end > source.length) return null;
	return { text: source.slice(scope.start, scope.end) };
}

export function dockScopeLabel(index: ScopeIndex, cst: Cst, scope: VersionScope): string {
	if (scope.kind === "block") return "Whole block";
	const node = nodeAtPath(cst, scope.path);
	if (scope.kind === "tab") {
		const title = node?.kind === "container" ? visibleTitle(node.title) : "";
		return `Tab · ${title || `Tab ${scope.siblingOrdinal + 1}`}`;
	}
	if (scope.kind === "tabs") return "Tab group";
	if (scope.kind === "grid") {
		const cols = node?.kind === "container" ? Number(attribute(node.title, "cols") ?? 2) || 2 : 2;
		const cells =
			node?.kind === "container"
				? node.children.filter((child) => child.kind === "container" && child.name === "cell").length
				: 0;
		return `Grid · ${Math.max(1, Math.ceil(cells / cols))}×${cols}`;
	}
	if (scope.kind === "cell") return `Cell ${scope.siblingOrdinal + 1}`;
	if (scope.kind === "section" && node?.kind === "container" && node.name === "section") return "Combined section";
	const source = index.source.slice(scope.start, scope.end);
	if (scope.kind === "code") {
		const info = source.match(/^(?:`{3,}|~{3,})\s*([^\r\n]*)/)?.[1]?.trim();
		return info ? `Code · ${info}` : "Code block";
	}
	if (scope.kind === "callout") {
		const title = source.match(/^>\s*\[![^\]]+\][+-]?\s*(.*)$/m)?.[1]?.trim();
		return title ? `Callout · ${title}` : "Callout";
	}
	const first = firstNonBlankLine(source)?.replace(/^#{1,6}\s+/, "");
	return first ? `Text · ${first.slice(0, 44)}` : "Text section";
}

export function dockScopeBreadcrumb(index: ScopeIndex, cst: Cst, scope: VersionScope): string[] {
	const chain: VersionScope[] = [];
	let current: VersionScope | undefined = scope;
	while (current) {
		chain.push(current);
		current = current.parentKey ? index.byKey.get(current.parentKey) : undefined;
	}
	return chain.reverse().map((candidate) => dockScopeLabel(index, cst, candidate));
}

function describeTarget(index: ScopeIndex, cst: Cst, scope: VersionScope, reason: DockTargetReason): DockTargetState {
	return {
		reason,
		scope,
		label: dockScopeLabel(index, cst, scope),
		breadcrumb: dockScopeBreadcrumb(index, cst, scope),
	};
}

/** Labels need only the first authored line; avoid splitting and trimming an
 * entire large section whenever the dock target is described. */
function firstNonBlankLine(source: string): string | null {
	let start = 0;
	while (start <= source.length) {
		const newline = source.indexOf("\n", start);
		const end = newline < 0 ? source.length : newline;
		const line = source.slice(start, end).trim();
		if (line) return line;
		if (newline < 0) return null;
		start = newline + 1;
	}
	return null;
}

function containingSibling(scopes: readonly VersionScope[], from: number, to: number): VersionScope | null {
	let low = 0;
	let high = scopes.length - 1;
	let candidate = -1;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		if (scopes[middle].start <= from) {
			candidate = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	for (let index = candidate; index >= 0 && scopes[index].start <= from; index--) {
		const scope = scopes[index];
		if (scope.end >= to) return scope;
		if (scope.end <= from) break;
	}
	return null;
}

function nodeAtPath(cst: Cst, path: readonly number[]): MicaNode | null {
	let children = cst.children;
	let current: MicaNode | null = null;
	for (const index of path) {
		current = children[index] ?? null;
		if (!current) return null;
		children = current.kind === "container" ? current.children : [];
	}
	return current;
}

function containerMatches(kind: VersionScopeKind, name: string): boolean {
	return (
		(kind === "tabs" && name === "tabs") ||
		(kind === "tab" && name === "tab") ||
		(kind === "grid" && name === "grid") ||
		(kind === "cell" && name === "cell") ||
		(kind === "section" && name === "section")
	);
}

function visibleTitle(title: string): string {
	const trimmed = title.trimEnd();
	if (!trimmed.endsWith("}")) return trimmed.trim();
	const open = trimmed.lastIndexOf("{");
	return open < 0 ? trimmed.trim() : trimmed.slice(0, open).trim();
}

function attribute(title: string, key: string): string | null {
	const match = title.match(new RegExp(`(?:^|\\s)${key}=([^\\s}]+)`));
	return match?.[1] ?? null;
}
