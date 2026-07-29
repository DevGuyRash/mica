import type { Cst, MicaNode } from "../wasm/bridge";
import { classifySection } from "./sectionFormat";

export type VersionScopeKind = "block" | "tabs" | "tab" | "grid" | "cell" | "section" | "callout" | "code";
export interface VersionScope {
	key: string;
	kind: VersionScopeKind;
	family: VersionScopeKind | "section-family";
	path: number[];
	parentKey: string | null;
	ancestry: string[];
	/** Case-folded, for matching. An authored title for containers; a leaf's
	 * first content line otherwise. Only the former is safe to show as a name. */
	label: string;
	/** `label` as the user actually wrote it. Matching folds case; display must
	 * not — a tab called "Main" is not called "main". */
	title: string;
	/** Ancestor titles as authored, parallel to `ancestry`. */
	titleAncestry: string[];
	container: boolean;
	shape: string;
	/** Position among siblings of the same *family*, which deliberately groups
	 * convertible kinds so a code→callout conversion stays trackable. Range
	 * selection spans these; they are not what a user counts. */
	siblingOrdinal: number;
	siblingCount: number;
	/** Position among siblings of the same visible kind. "Code block (2 of 3)"
	 * has to mean the third code block, not the third of a mixed run. */
	kindOrdinal: number;
	kindCount: number;
	start: number;
	end: number;
	fingerprintStart: number;
	fingerprintEnd: number;
	signature: string;
	previousSignature: string | null;
	nextSignature: string | null;
	previousKey: string | null;
	nextKey: string | null;
}
export interface ScopeLocator {
	kind: VersionScopeKind;
	signature: string;
	label: string;
	ancestry: string[];
	previousSignature: string | null;
	nextSignature: string | null;
	fingerprintText: string;
	previousText: string | null;
	nextText: string | null;
	/** Display-only, and deliberately the *origin* version's position: when an
	 * element cannot be resolved in a target snapshot, where it was is the only
	 * honest thing to name it by. Resolution never reads these. */
	container: boolean;
	title: string;
	titleAncestry: string[];
	kindOrdinal: number;
	kindCount: number;
}
export interface ScopeIndex {
	source: string;
	scopes: VersionScope[];
	byKey: Map<string, VersionScope>;
	bySignature: Map<string, VersionScope[]>;
	byCompatible: Map<string, VersionScope[]>;
	byFamily: Map<string, VersionScope[]>;
	byParentFamily: Map<string, VersionScope[]>;
}
export type ScopeResolution =
	| {
			kind: "exact";
			scope: VersionScope;
			evidence: "fingerprint" | "compatible" | "manual" | "transition";
			details?: string[];
			transitionStatus?: "unchanged" | "changed" | "converted" | "combined" | "split";
			composite?: VersionScope[];
	  }
	| { kind: "ambiguous"; candidates: VersionScope[]; truncated: boolean; details?: string[] }
	| { kind: "missing"; disposition?: "added" | "removed" | "unmatched"; details?: string[] };

const CONTAINER_KINDS = new Set<VersionScopeKind>(["tabs", "tab", "grid", "cell", "section"]);
const MAX_COMPATIBLE_CANDIDATES = 64;
export const MAX_SCOPE_INDEX_CODE_UNITS = 2 * 1024 * 1024;

export class ScopeIndexTooLargeError extends Error {
	constructor(readonly codeUnits: number) {
		super(`snapshot exceeds the ${Math.floor(MAX_SCOPE_INDEX_CODE_UNITS / 1024)} KiB inspector limit`);
		this.name = "ScopeIndexTooLargeError";
	}
}

export function scopeKey(kind: VersionScopeKind, path: readonly number[], region?: readonly [number, number]): string {
	return `${kind}:${path.join(".")}${region ? `:${region[0]}-${region[1]}` : ""}`;
}

/** Canonical compound keys shared by index construction and consumers. */
export function scopeSignatureKey(kind: VersionScopeKind, signature: string): string {
	return JSON.stringify([kind, signature]);
}

export function scopeParentFamilyKey(parentKey: string | null, family: VersionScope["family"]): string {
	return JSON.stringify([parentKey, family]);
}

export function buildScopeIndexFromCst(source: string, cst: Cst): ScopeIndex {
	if (source.length > MAX_SCOPE_INDEX_CODE_UNITS) throw new ScopeIndexTooLargeError(source.length);
	const rangeHash = rollingRangeHasher(source);
	const scopes: VersionScope[] = [];
	const add = (
		kind: VersionScopeKind,
		path: number[],
		parentKey: string | null,
		ancestry: string[],
		titleAncestry: string[],
		label: string,
		shape: string,
		start: number,
		end: number,
		region?: [number, number],
		fingerprintRange?: [number, number],
	): void => {
		const [fingerprintStart, fingerprintEnd] = fingerprintRange ?? [start, end];
		scopes.push({
			key: scopeKey(kind, path, region),
			kind,
			family: scopeFamily(kind),
			path: [...path],
			parentKey,
			ancestry: [...ancestry],
			titleAncestry: [...titleAncestry],
			label: normalizeLabel(label),
			title: displayTitle(label),
			// A region marks a leaf unit carved out of a run of leaves; containers
			// and the block root own a whole node and pass none. Only those carry
			// an authored title, so this is what makes `label` safe to display.
			container: region === undefined,
			shape,
			siblingOrdinal: 0,
			siblingCount: 1,
			kindOrdinal: 0,
			kindCount: 1,
			start,
			end,
			fingerprintStart,
			fingerprintEnd,
			signature: rangeHash(fingerprintStart, fingerprintEnd),
			previousSignature: null,
			nextSignature: null,
			previousKey: null,
			nextKey: null,
		});
	};
	add("block", [], null, [], [], "Block", "block", 0, source.length);
	const walk = (
		nodes: readonly MicaNode[],
		parentPath: number[],
		parentScopeKey: string,
		ancestry: string[],
		titleAncestry: string[],
		offset: number,
		insideLogicalSection = false,
	): number => {
		let cursor = offset;
		let index = 0;
		while (index < nodes.length) {
			const node = nodes[index];
			if (node.kind === "leaf") {
				const startIndex = index;
				while (index < nodes.length && nodes[index].kind === "leaf") index++;
				const leaves = nodes.slice(startIndex, index) as Extract<MicaNode, { kind: "leaf" }>[];
				let local = 0;
				for (const unit of leafUnits(leaves)) {
					const unitStart = cursor + local;
					const unitEnd = unitStart + unit.text.length;
					const classified = classifySection(unit.text);
					const kind: VersionScopeKind = classified === "markdown" ? "section" : classified;
					// A :::section is already one rendered/selectable logical scope. Its
					// Markdown body must not become a second scope with the same bytes;
					// nested callouts/code remain independently inspectable.
					if (!(insideLogicalSection && kind === "section")) {
						add(
							kind,
							parentPath,
							parentScopeKey,
							ancestry,
							titleAncestry,
							sectionLabel(unit.text, kind),
							`${scopeFamily(kind)}:${unit.text.split(/\r?\n/).length}`,
							unitStart,
							unitEnd,
							[startIndex + unit.start, startIndex + unit.end],
						);
					}
					local += unit.text.length;
				}
				for (const leaf of leaves) cursor += leaf.text.length;
				continue;
			}
			const start = cursor;
			const path = [...parentPath, index];
			const kind = CONTAINER_KINDS.has(node.name as VersionScopeKind) ? (node.name as VersionScopeKind) : null;
			const ownLabel = normalizeLabel(node.title) || node.name;
			const ownTitle = displayTitle(node.title) || node.name;
			const ownKey = kind ? scopeKey(kind, path) : parentScopeKey;
			cursor += node.open_line.length;
			cursor = walk(
				node.children,
				path,
				ownKey,
				[...ancestry, `${node.name}:${ownLabel}`],
				[...titleAncestry, ownTitle],
				cursor,
				insideLogicalSection || node.name === "section",
			);
			cursor += node.close_line.length;
			if (kind) {
				const contentStart = start + node.open_line.length;
				const contentEnd = cursor - node.close_line.length;
				add(
					kind,
					path,
					parentScopeKey,
					ancestry,
					titleAncestry,
					node.title.trim() || node.name,
					containerShape(node),
					start,
					cursor,
					undefined,
					[contentStart, contentEnd],
				);
			}
			index++;
		}
		return cursor;
	};
	walk(cst.children, [], "block:", [], [], 0);

	// Traversal emits each sibling group in source order. Link neighbors in one
	// pass instead of sorting, preserving O(source + nodes) construction.
	const siblingGroups = new Map<string, VersionScope[]>();
	const kindGroups = new Map<string, VersionScope[]>();
	for (const scope of scopes) {
		if (!scope.parentKey) continue;
		pushIndex(siblingGroups, scopeParentFamilyKey(scope.parentKey, scope.family), scope);
		pushIndex(kindGroups, JSON.stringify([scope.parentKey, scope.kind]), scope);
	}
	for (const peers of kindGroups.values())
		for (const [ordinal, scope] of peers.entries()) {
			scope.kindOrdinal = ordinal;
			scope.kindCount = peers.length;
		}
	for (const siblings of siblingGroups.values()) {
		for (const [ordinal, scope] of siblings.entries()) {
			scope.siblingOrdinal = ordinal;
			scope.siblingCount = siblings.length;
			const previous = siblings[ordinal - 1];
			const next = siblings[ordinal + 1];
			scope.previousSignature = previous?.signature ?? null;
			scope.previousKey = previous?.key ?? null;
			scope.nextSignature = next?.signature ?? null;
			scope.nextKey = next?.key ?? null;
		}
	}
	const byKey = new Map<string, VersionScope>();
	const bySignature = new Map<string, VersionScope[]>();
	const byCompatible = new Map<string, VersionScope[]>();
	const byFamily = new Map<string, VersionScope[]>();
	const byParentFamily = new Map<string, VersionScope[]>();
	for (const scope of scopes) {
		byKey.set(scope.key, scope);
		pushIndex(bySignature, scopeSignatureKey(scope.kind, scope.signature), scope);
		pushIndex(byCompatible, compatibleKey(scope), scope);
		pushIndex(byFamily, scope.family, scope);
		pushIndex(byParentFamily, scopeParentFamilyKey(scope.parentKey, scope.family), scope);
	}
	return { source, scopes, byKey, bySignature, byCompatible, byFamily, byParentFamily };
}

export function locatorFor(scope: VersionScope, index: ScopeIndex): ScopeLocator {
	return {
		kind: scope.kind,
		signature: scope.signature,
		label: scope.label,
		ancestry: [...scope.ancestry],
		previousSignature: scope.previousSignature,
		nextSignature: scope.nextSignature,
		fingerprintText: scopeFingerprint(index, scope),
		previousText: scope.previousKey ? scopeFingerprint(index, index.byKey.get(scope.previousKey)!) : null,
		nextText: scope.nextKey ? scopeFingerprint(index, index.byKey.get(scope.nextKey)!) : null,
		container: scope.container,
		title: scope.title,
		titleAncestry: [...scope.titleAncestry],
		kindOrdinal: scope.kindOrdinal,
		kindCount: scope.kindCount,
	};
}

export function resolveScope(index: ScopeIndex, locator: ScopeLocator, manualKey?: string): ScopeResolution {
	if (manualKey) {
		const manual = index.byKey.get(manualKey);
		return manual ? { kind: "exact", scope: manual, evidence: "manual" } : { kind: "missing" };
	}
	const exact: VersionScope[] = [];
	let exactTruncated = false;
	for (const candidate of index.bySignature.get(scopeSignatureKey(locator.kind, locator.signature)) ?? []) {
		if (scopeFingerprint(index, candidate) !== locator.fingerprintText) continue;
		if (exact.length < MAX_COMPATIBLE_CANDIDATES) exact.push(candidate);
		else {
			exactTruncated = true;
			break;
		}
	}
	if (exact.length === 1) return { kind: "exact", scope: exact[0], evidence: "fingerprint" };
	if (exact.length > 1) return { kind: "ambiguous", candidates: exact, truncated: exactTruncated };
	const compatible = index.byCompatible.get(compatibleKey(locator)) ?? [];
	if (compatible.length > MAX_COMPATIBLE_CANDIDATES)
		return { kind: "ambiguous", candidates: compatible.slice(0, MAX_COMPATIBLE_CANDIDATES), truncated: true };
	if (compatible.length === 1) return { kind: "exact", scope: compatible[0], evidence: "compatible" };
	if (compatible.length > 1) {
		const neighborMatches = compatible.filter((candidate) => {
			const previous = candidate.previousKey ? index.byKey.get(candidate.previousKey) : null;
			const next = candidate.nextKey ? index.byKey.get(candidate.nextKey) : null;
			return (
				(locator.previousText !== null &&
					previous &&
					scopeFingerprint(index, previous) === locator.previousText) ||
				(locator.nextText !== null && next && scopeFingerprint(index, next) === locator.nextText)
			);
		});
		if (neighborMatches.length === 1) return { kind: "exact", scope: neighborMatches[0], evidence: "compatible" };
		return {
			kind: "ambiguous",
			candidates: neighborMatches.length ? neighborMatches : compatible,
			truncated: false,
		};
	}
	return { kind: "missing" };
}

/** Fields any element name needs, satisfied by both a resolved scope and the
 * locator that stands in for one when resolution failed. */
export type ScopeDisplayFields = Pick<
	VersionScope,
	"ancestry" | "titleAncestry" | "kind" | "title" | "container" | "kindOrdinal" | "kindCount"
>;

/**
 * How an element is identified to a user: where it lives, what it is, and which
 * one — `Block › tabs › test › Code block (2 of 3)`.
 *
 * The final segment is an authored container title where one exists and the
 * element's type otherwise, because a leaf's `label` is its first content line:
 * neither stable across edits nor able to tell siblings apart. The ordinal is
 * what actually separates three code blocks inside the same tab.
 */
export function scopeDisplayName(scope: ScopeDisplayFields): string {
	if (scope.kind === "block") return "Block";
	// `ancestry` supplies each ancestor's kind; `titleAncestry` supplies the
	// title as authored. They are built together and stay index-aligned.
	const trail = ["Block", ...scope.ancestry.map((part, index) => ancestrySegment(part, scope.titleAncestry[index]))];
	trail.push(titleOf(scope.kind, scope.title, scope.container));
	const name = trail.join(" › ");
	return scope.kindCount > 1 ? `${name} (${scope.kindOrdinal + 1} of ${scope.kindCount})` : name;
}

/** Ancestry entries are `kind:label`; an untitled container echoes its own node
 * name back as the label. Both render as the container's type. */
function ancestrySegment(part: string, title: string | undefined): string {
	const split = part.indexOf(":");
	const kind = (split < 0 ? part : part.slice(0, split)) as VersionScopeKind;
	return titleOf(kind, title ?? "", true);
}

function titleOf(kind: VersionScopeKind, title: string, container: boolean): string {
	return container && title && title.toLocaleLowerCase() !== kind ? title : kindLabel(kind);
}

export function scopeSource(index: ScopeIndex, scope: Pick<VersionScope, "start" | "end">): string {
	return index.source.slice(scope.start, scope.end);
}

export function scopeFingerprint(
	index: ScopeIndex,
	scope: Pick<VersionScope, "fingerprintStart" | "fingerprintEnd">,
): string {
	return index.source.slice(scope.fingerprintStart, scope.fingerprintEnd);
}

function compatibleKey(scope: Pick<VersionScope, "kind" | "label" | "ancestry">): string {
	return tupleKey(scope.kind, scope.label, scope.ancestry);
}
function tupleKey(kind: string, label: string, ancestry: readonly string[]): string {
	return JSON.stringify([kind, label, ancestry]);
}
function pushIndex(map: Map<string, VersionScope[]>, key: string, value: VersionScope): void {
	const values = map.get(key);
	if (values) values.push(value);
	else map.set(key, [value]);
}
/** Trimmed and whitespace-collapsed, but never case-folded: this is the text
 * the user typed. */
function displayTitle(label: string): string {
	return label.trim().replace(/\s+/g, " ");
}
function normalizeLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
function scopeFamily(kind: VersionScopeKind): VersionScopeKind | "section-family" {
	return kind === "section" || kind === "callout" || kind === "code" ? "section-family" : kind;
}
function containerShape(node: Extract<MicaNode, { kind: "container" }>): string {
	const children = node.children.map((child) => (child.kind === "container" ? child.name : "leaf"));
	return `${node.name}:${children.length}:${children.slice(0, 32).join(",")}`;
}
function sectionLabel(text: string, kind: VersionScopeKind): string {
	const line = text.split(/\r?\n/, 1)[0].trim();
	if (kind === "callout") return line.replace(/^>\s*\[![^\]]+\][+-]?\s*/, "");
	if (kind === "code") return line.replace(/^(`{3,}|~{3,})\s*/, "");
	return line.replace(/^#{1,6}\s+/, "").slice(0, 80);
}
function kindLabel(kind: VersionScopeKind): string {
	return kind === "code" ? "Code block" : kind[0].toUpperCase() + kind.slice(1);
}
function leafUnits(
	leaves: readonly Extract<MicaNode, { kind: "leaf" }>[],
): { start: number; end: number; text: string }[] {
	const whitespace = (index: number): boolean => index < leaves.length && !leaves[index].text.trim();
	const units: { start: number; end: number; text: string }[] = [];
	let index = 0;
	while (index < leaves.length) {
		const start = index;
		while (whitespace(index)) index++;
		if (index < leaves.length) index++;
		while (whitespace(index)) index++;
		let text = "";
		for (let leaf = start; leaf < index; leaf++) text += leaves[leaf].text;
		units.push({ start, end: index, text });
	}
	return units;
}

/** A 32-bit polynomial range hash makes lookup O(1) with two compact prefix
 * arrays (8 bytes/code unit). It is only an accelerator: resolver decisions
 * verify exact source bytes, so collisions can cost time but never mis-pair. */
function rollingRangeHasher(source: string): (start: number, end: number) => string {
	const length = source.length;
	const prefixA = new Uint32Array(length + 1);
	const powerA = new Uint32Array(length + 1);
	powerA[0] = 1;
	for (let index = 0; index < length; index++) {
		const unit = source.charCodeAt(index) + 1;
		prefixA[index + 1] = (Math.imul(prefixA[index], 1_000_003) + unit) >>> 0;
		powerA[index + 1] = Math.imul(powerA[index], 1_000_003) >>> 0;
	}
	return (start, end) => {
		const span = end - start;
		const a = (prefixA[end] - Math.imul(prefixA[start], powerA[span])) >>> 0;
		return `${span}:${a.toString(16)}`;
	};
}
