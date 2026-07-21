import type { Cst, MicaNode } from "../wasm/bridge";
import { classifySection } from "./sectionFormat";

export type VersionScopeKind = "block" | "tabs" | "tab" | "grid" | "cell" | "section" | "callout" | "code";
export interface VersionScope {
	key: string;
	kind: VersionScopeKind;
	path: number[];
	ancestry: string[];
	label: string;
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
}
export interface ScopeIndex {
	source: string;
	scopes: VersionScope[];
	byKey: Map<string, VersionScope>;
	bySignature: Map<string, VersionScope[]>;
	byCompatible: Map<string, VersionScope[]>;
}
export type ScopeResolution =
	| { kind: "exact"; scope: VersionScope; evidence: "fingerprint" | "compatible" | "manual" }
	| { kind: "ambiguous"; candidates: VersionScope[]; truncated: boolean }
	| { kind: "missing" };

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

export function buildScopeIndexFromCst(source: string, cst: Cst): ScopeIndex {
	if (source.length > MAX_SCOPE_INDEX_CODE_UNITS) throw new ScopeIndexTooLargeError(source.length);
	const rangeHash = rollingRangeHasher(source);
	const scopes: VersionScope[] = [];
	const add = (
		kind: VersionScopeKind,
		path: number[],
		ancestry: string[],
		label: string,
		start: number,
		end: number,
		region?: [number, number],
		fingerprintRange?: [number, number],
	): void => {
		const [fingerprintStart, fingerprintEnd] = fingerprintRange ?? [start, end];
		scopes.push({
			key: scopeKey(kind, path, region),
			kind,
			path: [...path],
			ancestry: [...ancestry],
			label: normalizeLabel(label),
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
	add("block", [], [], "Block", 0, source.length);
	const walk = (
		nodes: readonly MicaNode[],
		parentPath: number[],
		ancestry: string[],
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
						add(kind, parentPath, ancestry, sectionLabel(unit.text, kind), unitStart, unitEnd, [
							startIndex + unit.start,
							startIndex + unit.end,
						]);
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
			cursor += node.open_line.length;
			cursor = walk(
				node.children,
				path,
				[...ancestry, `${node.name}:${ownLabel}`],
				cursor,
				insideLogicalSection || node.name === "section",
			);
			cursor += node.close_line.length;
			if (kind) {
				const contentStart = start + node.open_line.length;
				const contentEnd = cursor - node.close_line.length;
				add(kind, path, ancestry, ownLabel, start, cursor, undefined, [contentStart, contentEnd]);
			}
			index++;
		}
		return cursor;
	};
	walk(cst.children, [], [], 0);

	// Traversal emits each sibling group in source order. Link neighbors in one
	// pass instead of sorting, preserving O(source + nodes) construction.
	const lastSibling = new Map<string, VersionScope>();
	for (const scope of scopes) {
		const group = tupleKey(scope.kind, "", scope.ancestry);
		const previous = lastSibling.get(group);
		if (previous) {
			scope.previousSignature = previous.signature;
			scope.previousKey = previous.key;
			previous.nextSignature = scope.signature;
			previous.nextKey = scope.key;
		}
		lastSibling.set(group, scope);
	}
	const byKey = new Map<string, VersionScope>();
	const bySignature = new Map<string, VersionScope[]>();
	const byCompatible = new Map<string, VersionScope[]>();
	for (const scope of scopes) {
		byKey.set(scope.key, scope);
		pushIndex(bySignature, signatureKey(scope.kind, scope.signature), scope);
		pushIndex(byCompatible, compatibleKey(scope), scope);
	}
	return { source, scopes, byKey, bySignature, byCompatible };
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
	};
}

export function resolveScope(index: ScopeIndex, locator: ScopeLocator, manualKey?: string): ScopeResolution {
	if (manualKey) {
		const manual = index.byKey.get(manualKey);
		return manual ? { kind: "exact", scope: manual, evidence: "manual" } : { kind: "missing" };
	}
	const exact: VersionScope[] = [];
	let exactTruncated = false;
	for (const candidate of index.bySignature.get(signatureKey(locator.kind, locator.signature)) ?? []) {
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

export function scopeBreadcrumb(scope: Pick<VersionScope, "ancestry" | "kind" | "label">): string[] {
	if (scope.kind === "block") return ["Block"];
	return ["Block", ...scope.ancestry.map((part) => part.replace(/^\w+:/, "")), scope.label || kindLabel(scope.kind)];
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
function tupleKey(kind: VersionScopeKind, label: string, ancestry: readonly string[]): string {
	return JSON.stringify([kind, label, ancestry]);
}
function signatureKey(kind: VersionScopeKind, signature: string): string {
	return JSON.stringify([kind, signature]);
}
function pushIndex(map: Map<string, VersionScope[]>, key: string, value: VersionScope): void {
	const values = map.get(key);
	if (values) values.push(value);
	else map.set(key, [value]);
}
function normalizeLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLocaleLowerCase();
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
