import {
	scopeParentFamilyKey,
	scopeSignatureKey,
	scopeFingerprint,
	type ScopeIndex,
	type ScopeResolution,
	type VersionScope,
	type VersionScopeKind,
} from "./versionScopeCore";

const MAX_CANDIDATES_PER_SCOPE = 64;
const ORDINAL_CANDIDATE_RADIUS = 6;
const NON_EXACT_MARGIN = 12;
const HIGH_SIMILARITY = 0.66;
const VERY_HIGH_SIMILARITY = 0.82;
const MEDIUM_SIMILARITY = 0.5;
const GENERIC_LABELS = new Set(["", "block", "tabs", "tab", "grid", "cell", "section", "code", "code block"]);

export type TransitionStatus = "unchanged" | "changed" | "converted" | "combined" | "split";
export type TransitionEvidence =
	| "exact content"
	| "mapped parent"
	| "stable label"
	| "previous anchor"
	| "next anchor"
	| "structural shape"
	| "content similarity";

export interface ScopeTransitionMatch {
	from: VersionScope;
	to: VersionScope;
	status: TransitionStatus;
	evidence: TransitionEvidence[];
	score: number;
}

export interface ScopeTransition {
	forward: Map<string, ScopeTransitionMatch>;
	reverse: Map<string, ScopeTransitionMatch>;
	ambiguousFrom: Map<string, VersionScope[]>;
	ambiguousTo: Map<string, VersionScope[]>;
	combinedTo: Map<string, VersionScope[]>;
	splitTo: Map<string, { from: VersionScope; into: VersionScope[] }>;
	added: Set<string>;
	removed: Set<string>;
}

/** Resolve one scope in a child snapshot against its direct parent. This is
 * shared by direct and Auto-lineage UI paths so split/combine/add semantics
 * cannot drift from the transition model. */
export function resolveSelectedTransition(transition: ScopeTransition, selectedScope: VersionScope): ScopeResolution {
	const match = transition.reverse.get(selectedScope.key);
	if (match)
		return {
			kind: "exact",
			scope: match.from,
			evidence: "transition",
			details: match.evidence,
			transitionStatus: match.status,
		};
	const combined = transition.combinedTo.get(selectedScope.key);
	if (combined?.length)
		return {
			kind: "exact",
			scope: combined[0],
			composite: combined,
			evidence: "transition",
			details: [`combined from ${combined.length} adjacent sections`],
			transitionStatus: "combined",
		};
	const split = transition.splitTo.get(selectedScope.key);
	if (split)
		return {
			kind: "exact",
			scope: split.from,
			composite: [split.from],
			evidence: "transition",
			details: [`split into ${split.into.length} adjacent sections`],
			transitionStatus: "split",
		};
	const candidates = transition.ambiguousTo.get(selectedScope.key);
	if (candidates?.length)
		return {
			kind: "ambiguous",
			candidates,
			truncated: candidates.length >= MAX_CANDIDATES_PER_SCOPE,
			details: ["plausible counterparts remain"],
		};
	return {
		kind: "missing",
		disposition: transition.added.has(selectedScope.key) ? "added" : "unmatched",
	};
}

interface Candidate {
	from: VersionScope;
	to: VersionScope;
	evidence: TransitionEvidence[];
	score: number;
	similarity: number;
	eligible: boolean;
}

export interface ContentResemblance {
	orderedTokens: number;
	tokenFrequency: number;
	lineAnchors: number;
	weighted: number;
}

interface SimilaritySketch {
	tokens: Map<number, number>;
	ordered: Map<number, number>;
	lines: Set<number>;
	tokenCount: number;
}

/** Build a conservative one-to-one identity map for one lineage transition.
 * Candidate generation is indexed and bounded; no scope is paired solely by
 * numeric path, similarity, or a weak neighboring anchor. */
export function buildScopeTransition(fromIndex: ScopeIndex, toIndex: ScopeIndex): ScopeTransition {
	const transition: ScopeTransition = {
		forward: new Map(),
		reverse: new Map(),
		ambiguousFrom: new Map(),
		ambiguousTo: new Map(),
		combinedTo: new Map(),
		splitTo: new Map(),
		added: new Set(),
		removed: new Set(),
	};
	const fromBlock = fromIndex.byKey.get("block:");
	const toBlock = toIndex.byKey.get("block:");
	if (fromBlock && toBlock) {
		const unchanged = scopeFingerprint(fromIndex, fromBlock) === scopeFingerprint(toIndex, toBlock);
		accept(transition, {
			from: fromBlock,
			to: toBlock,
			status: unchanged ? "unchanged" : "changed",
			evidence: unchanged ? ["exact content"] : ["mapped parent"],
			score: 1_000,
		});
	}

	const fromLabel = labelIndex(fromIndex.scopes);
	const fromSiblingLabels = siblingLabelCounts(fromIndex.scopes);
	const toSiblingLabels = siblingLabelCounts(toIndex.scopes);
	const fromSketches = new Map<string, SimilaritySketch>();
	const toSketches = new Map<string, SimilaritySketch>();

	// Parent matches unlock children at every nesting depth. Each scope appears
	// in one depth bucket; up to three local passes let newly mapped siblings
	// unlock duplicates without rescanning unrelated depths.
	const scopesByDepth: VersionScope[][] = [];
	for (const scope of toIndex.scopes) (scopesByDepth[scope.path.length] ??= []).push(scope);
	for (const depthScopes of scopesByDepth) {
		if (!depthScopes) continue;
		for (let pass = 0; pass < 3; pass++) {
			const candidates = new Map<string, Candidate[]>();
			const reverseCandidates = new Map<string, Candidate[]>();
			for (const to of depthScopes) {
				if (transition.reverse.has(to.key) || to.kind === "block") continue;
				const pool = candidatePool(fromIndex, fromLabel, transition, to);
				for (const from of pool) {
					if (transition.forward.has(from.key)) continue;
					const candidate = evaluateCandidate(
						fromIndex,
						toIndex,
						transition,
						from,
						to,
						fromSketches,
						toSketches,
						fromSiblingLabels,
						toSiblingLabels,
					);
					push(candidates, to.key, candidate);
					push(reverseCandidates, from.key, candidate);
				}
			}
			let accepted = 0;
			for (const [toKey, choices] of candidates) {
				const ranked = choices.sort(compareCandidates);
				const best = ranked[0];
				if (!best?.eligible || transition.forward.has(best.from.key) || transition.reverse.has(toKey)) continue;
				const reverseRanked = (reverseCandidates.get(best.from.key) ?? []).sort(compareCandidates);
				if (reverseRanked[0]?.to.key !== toKey) continue;
				if (!hasSafeMargin(best, ranked[1]) || !hasSafeMargin(best, reverseRanked[1])) continue;
				accept(transition, {
					from: best.from,
					to: best.to,
					status:
						best.from.kind !== best.to.kind
							? "converted"
							: fullSource(fromIndex, best.from) === fullSource(toIndex, best.to)
								? "unchanged"
								: "changed",
					evidence: best.evidence,
					score: best.score,
				});
				accepted++;
			}
			if (!accepted) break;
		}
	}

	detectSectionTransforms(fromIndex, toIndex, transition);
	const transformedFrom = new Set<string>();
	const transformedTo = new Set<string>();
	for (const [toKey, sources] of transition.combinedTo) {
		transformedTo.add(toKey);
		for (const source of sources) transformedFrom.add(source.key);
	}
	for (const [toKey, relation] of transition.splitTo) {
		transformedTo.add(toKey);
		transformedFrom.add(relation.from.key);
	}

	// Recompute unresolved candidate edges with the final anchors. An isolated
	// unmatched scope is truly added/removed; any surviving edge needs a person.
	const unresolvedFrom = new Map<string, VersionScope[]>();
	const unresolvedTo = new Map<string, VersionScope[]>();
	for (const to of toIndex.scopes) {
		if (transition.reverse.has(to.key) || transformedTo.has(to.key) || to.kind === "block") continue;
		for (const from of candidatePool(fromIndex, fromLabel, transition, to)) {
			if (transition.forward.has(from.key) || transformedFrom.has(from.key)) continue;
			const candidate = evaluateCandidate(
				fromIndex,
				toIndex,
				transition,
				from,
				to,
				fromSketches,
				toSketches,
				fromSiblingLabels,
				toSiblingLabels,
			);
			if (candidate.score < 25) continue;
			// candidatePool is key-deduplicated and each `to` scope is visited
			// once, so every edge is unique. Cap while accumulating instead of
			// retaining unbounded arrays only to slice them during publication.
			pushBounded(unresolvedTo, to.key, from, MAX_CANDIDATES_PER_SCOPE);
			pushBounded(unresolvedFrom, from.key, to, MAX_CANDIDATES_PER_SCOPE);
		}
	}
	for (const to of toIndex.scopes) {
		if (to.kind === "block" || transition.reverse.has(to.key) || transformedTo.has(to.key)) continue;
		const plausible = unresolvedTo.get(to.key);
		if (plausible?.length) transition.ambiguousTo.set(to.key, plausible.slice(0, MAX_CANDIDATES_PER_SCOPE));
		else transition.added.add(to.key);
	}
	for (const from of fromIndex.scopes) {
		if (from.kind === "block" || transition.forward.has(from.key) || transformedFrom.has(from.key)) continue;
		const plausible = unresolvedFrom.get(from.key);
		if (plausible?.length) transition.ambiguousFrom.set(from.key, plausible.slice(0, MAX_CANDIDATES_PER_SCOPE));
		else transition.removed.add(from.key);
	}
	return transition;
}

function candidatePool(
	fromIndex: ScopeIndex,
	fromLabel: Map<string, VersionScope[]>,
	transition: ScopeTransition,
	to: VersionScope,
): VersionScope[] {
	const pool = new Map<string, VersionScope>();
	const mappedParent = to.parentKey ? transition.reverse.get(to.parentKey)?.from.key : null;
	if (mappedParent) {
		const siblings = fromIndex.byParentFamily.get(scopeParentFamilyKey(mappedParent, to.family)) ?? [];
		// Numeric proximity only generates a bounded local candidate window; it
		// never authorizes a match. Local parent continuity is considered before
		// global duplicate buckets so the correct family cannot be crowded out.
		const start = Math.max(0, to.siblingOrdinal - ORDINAL_CANDIDATE_RADIUS);
		const end = Math.min(siblings.length, to.siblingOrdinal + ORDINAL_CANDIDATE_RADIUS + 1);
		for (let index = start; index < end; index++) pool.set(siblings[index].key, siblings[index]);
	}
	const exact = fromIndex.bySignature.get(scopeSignatureKey(to.kind, to.signature)) ?? [];
	for (const scope of exact) {
		pool.set(scope.key, scope);
		if (pool.size >= MAX_CANDIDATES_PER_SCOPE) return [...pool.values()];
	}
	if (informativeLabel(to)) {
		for (const scope of fromLabel.get(labelKey(to.family, to.label)) ?? []) {
			pool.set(scope.key, scope);
			if (pool.size >= MAX_CANDIDATES_PER_SCOPE) return [...pool.values()];
		}
	}
	return [...pool.values()];
}

function evaluateCandidate(
	fromIndex: ScopeIndex,
	toIndex: ScopeIndex,
	transition: ScopeTransition,
	from: VersionScope,
	to: VersionScope,
	fromSketches: Map<string, SimilaritySketch>,
	toSketches: Map<string, SimilaritySketch>,
	fromSiblingLabels: ReadonlyMap<string, number>,
	toSiblingLabels: ReadonlyMap<string, number>,
): Candidate {
	const evidence: TransitionEvidence[] = [];
	const sameKind = from.kind === to.kind;
	const exact =
		sameKind &&
		from.signature === to.signature &&
		scopeFingerprint(fromIndex, from) === scopeFingerprint(toIndex, to);
	if (exact) evidence.push("exact content");
	const mappedParent =
		from.parentKey !== null &&
		to.parentKey !== null &&
		transition.forward.get(from.parentKey)?.to.key === to.parentKey;
	if (mappedParent) evidence.push("mapped parent");
	const label = informativeLabel(from) && informativeLabel(to) && from.label === to.label;
	if (label) evidence.push("stable label");
	const previous =
		from.previousKey !== null &&
		to.previousKey !== null &&
		transition.forward.get(from.previousKey)?.to.key === to.previousKey;
	if (previous) evidence.push("previous anchor");
	const next =
		from.nextKey !== null && to.nextKey !== null && transition.forward.get(from.nextKey)?.to.key === to.nextKey;
	if (next) evidence.push("next anchor");
	const shape = from.shape === to.shape;
	if (shape) evidence.push("structural shape");

	let similarity = exact ? 1 : 0;
	const needsSimilarity = mappedParent || label || previous || next;
	if (!exact && needsSimilarity) {
		similarity = sketchSimilarity(
			sketchFor(fromIndex, from, fromSketches),
			sketchFor(toIndex, to, toSketches),
		).weighted;
		if (similarity >= MEDIUM_SIMILARITY) evidence.push("content similarity");
	}

	let score = exact ? 120 : 0;
	if (mappedParent) score += 35;
	if (label) score += 25;
	if (previous) score += 18;
	if (next) score += 18;
	if (shape) score += 8;
	score += Math.round(similarity * 30);
	if (!sameKind) score -= 12;

	const anchored = previous || next;
	const bothNeighbors = previous && next;
	const structuralContainer = to.kind === "tabs" || to.kind === "grid";
	const singletonFamily =
		(fromIndex.byParentFamily.get(scopeParentFamilyKey(from.parentKey, from.family))?.length ?? 0) === 1 &&
		(toIndex.byParentFamily.get(scopeParentFamilyKey(to.parentKey, to.family))?.length ?? 0) === 1;
	const exactUnique =
		(fromIndex.bySignature.get(scopeSignatureKey(from.kind, from.signature))?.length ?? 0) === 1 &&
		(toIndex.bySignature.get(scopeSignatureKey(to.kind, to.signature))?.length ?? 0) === 1;
	const labelUnique =
		label &&
		(fromSiblingLabels.get(siblingLabelKey(from)) ?? 0) === 1 &&
		(toSiblingLabels.get(siblingLabelKey(to)) ?? 0) === 1;
	const conflictingLabels = informativeLabel(from) && informativeLabel(to) && from.label !== to.label;
	const eligible = exact
		? exactUnique || (mappedParent && (labelUnique || bothNeighbors))
		: mappedParent &&
			(conflictingLabels
				? (singletonFamily && similarity >= MEDIUM_SIMILARITY) || (similarity >= 0.9 && anchored)
				: sameKind
					? (structuralContainer && shape && (label || anchored || similarity >= HIGH_SIMILARITY)) ||
						(label && (similarity >= MEDIUM_SIMILARITY || anchored)) ||
						(!informativeLabel(to) && singletonFamily && similarity >= MEDIUM_SIMILARITY) ||
						(!informativeLabel(to) && similarity >= VERY_HIGH_SIMILARITY && (anchored || shape)) ||
						(informativeLabel(to) && similarity >= HIGH_SIMILARITY && (anchored || shape)) ||
						(bothNeighbors && similarity >= MEDIUM_SIMILARITY)
					: similarity >= 0.92 || (similarity >= HIGH_SIMILARITY && (label || anchored)));
	return { from, to, evidence, score, similarity, eligible };
}

function siblingLabelCounts(scopes: readonly VersionScope[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const scope of scopes) {
		const key = siblingLabelKey(scope);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

function siblingLabelKey(scope: VersionScope): string {
	return JSON.stringify([scope.parentKey, scope.family, scope.label]);
}

function fullSource(index: ScopeIndex, scope: VersionScope): string {
	return index.source.slice(scope.start, scope.end);
}

function hasSafeMargin(best: Candidate, runnerUp: Candidate | undefined): boolean {
	if (best.evidence.includes("exact content") && !runnerUp?.evidence.includes("exact content")) return true;
	return !runnerUp || best.score - runnerUp.score >= NON_EXACT_MARGIN;
}

function compareCandidates(left: Candidate, right: Candidate): number {
	return right.score - left.score || left.from.start - right.from.start || left.to.start - right.to.start;
}

function accept(transition: ScopeTransition, match: ScopeTransitionMatch): void {
	transition.forward.set(match.from.key, match);
	transition.reverse.set(match.to.key, match);
}

function labelIndex(scopes: readonly VersionScope[]): Map<string, VersionScope[]> {
	const index = new Map<string, VersionScope[]>();
	for (const scope of scopes) {
		if (informativeLabel(scope)) push(index, labelKey(scope.family, scope.label), scope);
	}
	return index;
}

function labelKey(family: VersionScope["family"], label: string): string {
	return JSON.stringify([family, label]);
}

function informativeLabel(scope: Pick<VersionScope, "kind" | "label">): boolean {
	return !GENERIC_LABELS.has(scope.label) && scope.label !== scope.kind;
}

function sketchFor(index: ScopeIndex, scope: VersionScope, cache: Map<string, SimilaritySketch>): SimilaritySketch {
	const cached = cache.get(scope.key);
	if (cached) return cached;
	const sketch = buildSimilaritySketch(scopeFingerprint(index, scope));
	cache.set(scope.key, sketch);
	return sketch;
}

/** One authority for resemblance preprocessing. Lower-casing once avoids a
 * second full-size string allocation for line anchors on every new scope. */
function buildSimilaritySketch(text: string): SimilaritySketch {
	const normalized = semanticText(text).toLocaleLowerCase();
	const tokens = normalized.match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
	const frequencies = new Map<number, number>();
	for (const token of tokens) increment(frequencies, hash(`u\u0000${token}`));
	const ordered = new Map<number, number>();
	if (tokens.length < 3) {
		for (const [token, count] of frequencies) ordered.set(token, count);
	} else {
		for (let index = 0; index + 2 < tokens.length; index++)
			increment(ordered, hash(`t\u0000${tokens[index]}\u0000${tokens[index + 1]}\u0000${tokens[index + 2]}`));
	}
	const lines = new Set(
		normalized
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => hash(`l\u0000${line}`)),
	);
	return { tokens: frequencies, ordered, lines, tokenCount: tokens.length };
}

function semanticText(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (/^\s*(`{3,}|~{3,})/.test(lines[0] ?? "")) {
		lines.shift();
		if (/^\s*(`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? "")) lines.pop();
	}
	return lines
		.filter((line) => !/^\s*:{3,}(?:section)?\s*$/.test(line))
		.map((line) => line.replace(/^\s*>\s?(?:\[![^\]]+\][+-]?\s*)?/, ""))
		.join("\n")
		.replace(/\s+/g, " ")
		.trim();
}

function detectSectionTransforms(fromIndex: ScopeIndex, toIndex: ScopeIndex, transition: ScopeTransition): void {
	const unmatchedFrom = fromIndex.scopes.filter(
		(scope) => scope.family === "section-family" && !transition.forward.has(scope.key),
	);
	const unmatchedTo = toIndex.scopes.filter(
		(scope) => scope.family === "section-family" && !transition.reverse.has(scope.key),
	);
	const fromText = new Map<string, string>();
	const toText = new Map<string, string>();
	const fromWindows = sectionWindowIndex(fromIndex, unmatchedFrom, fromText);
	const toWindows = sectionWindowIndex(toIndex, unmatchedTo, toText);
	const usedFrom = new Set<string>();
	const usedTo = new Set<string>();

	for (const to of unmatchedTo) {
		const mappedParent = to.parentKey ? transition.reverse.get(to.parentKey)?.from.key : null;
		if (!mappedParent) continue;
		const matches = fromWindows.get(JSON.stringify([mappedParent, semanticScopeText(toIndex, to, toText)])) ?? [];
		if (matches.length !== 1) continue;
		if (matches[0].some((scope) => usedFrom.has(scope.key))) continue;
		transition.combinedTo.set(to.key, matches[0]);
		usedTo.add(to.key);
		for (const scope of matches[0]) usedFrom.add(scope.key);
	}

	for (const from of unmatchedFrom) {
		if (usedFrom.has(from.key)) continue;
		const mappedParent = from.parentKey ? transition.forward.get(from.parentKey)?.to.key : null;
		if (!mappedParent) continue;
		const matches =
			toWindows.get(JSON.stringify([mappedParent, semanticScopeText(fromIndex, from, fromText)])) ?? [];
		if (matches.length !== 1) continue;
		if (matches[0].some((scope) => usedTo.has(scope.key))) continue;
		for (const scope of matches[0]) {
			transition.splitTo.set(scope.key, { from, into: matches[0] });
			usedTo.add(scope.key);
		}
		usedFrom.add(from.key);
	}
}

function sectionWindowIndex(
	index: ScopeIndex,
	scopes: VersionScope[],
	textCache: Map<string, string>,
): Map<string, VersionScope[][]> {
	const windows = new Map<string, VersionScope[][]>();
	const siblings = new Map<string, VersionScope[]>();
	for (const scope of scopes) push(siblings, scope.parentKey ?? "", scope);
	for (const [parent, group] of siblings) {
		group.sort((left, right) => left.siblingOrdinal - right.siblingOrdinal);
		for (let start = 0; start < group.length; start++) {
			for (let size = 2; size <= 4 && start + size <= group.length; size++) {
				const window = group.slice(start, start + size);
				if (window.some((scope, offset) => scope.siblingOrdinal !== window[0].siblingOrdinal + offset))
					continue;
				const joined = window
					.map((scope) => semanticScopeText(index, scope, textCache))
					.join(" ")
					.replace(/\s+/g, " ")
					.trim();
				push(windows, JSON.stringify([parent, joined]), window);
			}
		}
	}
	return windows;
}

function semanticScopeText(index: ScopeIndex, scope: VersionScope, cache: Map<string, string>): string {
	const cached = cache.get(scope.key);
	if (cached !== undefined) return cached;
	const text = semanticText(scopeFingerprint(index, scope));
	cache.set(scope.key, text);
	return text;
}

function sketchSimilarity(left: SimilaritySketch, right: SimilaritySketch): ContentResemblance {
	const orderedTokens = multisetDice(left.ordered, right.ordered);
	const tokenFrequency = multisetDice(left.tokens, right.tokens);
	const lineAnchors = setDice(left.lines, right.lines);
	return {
		orderedTokens,
		tokenFrequency,
		lineAnchors,
		weighted:
			Math.min(left.tokenCount, right.tokenCount) < 6
				? tokenFrequency
				: orderedTokens * 0.45 + tokenFrequency * 0.25 + lineAnchors * 0.3,
	};
}

export function contentResemblance(left: string, right: string): ContentResemblance {
	return sketchSimilarity(buildSimilaritySketch(left), buildSimilaritySketch(right));
}

function setDice(left: Set<number>, right: Set<number>): number {
	if (!left.size && !right.size) return 1;
	if (!left.size || !right.size) return 0;
	const smaller = left.size <= right.size ? left : right;
	const larger = smaller === left ? right : left;
	let intersection = 0;
	for (const value of smaller) if (larger.has(value)) intersection++;
	return (2 * intersection) / (left.size + right.size);
}

function multisetDice(left: Map<number, number>, right: Map<number, number>): number {
	let leftTotal = 0;
	let rightTotal = 0;
	let intersection = 0;
	for (const count of left.values()) leftTotal += count;
	for (const count of right.values()) rightTotal += count;
	if (!leftTotal && !rightTotal) return 1;
	if (!leftTotal || !rightTotal) return 0;
	const smaller = left.size <= right.size ? left : right;
	const larger = smaller === left ? right : left;
	for (const [value, count] of smaller) intersection += Math.min(count, larger.get(value) ?? 0);
	return (2 * intersection) / (leftTotal + rightTotal);
}

function increment(map: Map<number, number>, key: number): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function hash(value: string): number {
	let result = 2_166_136_261;
	for (let index = 0; index < value.length; index++) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16_777_619);
	}
	return result >>> 0;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
	const values = map.get(key);
	if (values) values.push(value);
	else map.set(key, [value]);
}

function pushBounded<T>(map: Map<string, T[]>, key: string, value: T, limit: number): void {
	const values = map.get(key);
	if (values && values.length >= limit) return;
	push(map, key, value);
}

export function transitionStatusLabel(match: ScopeTransitionMatch): string {
	if (match.status === "converted") return `converted ${kindLabel(match.from.kind)} → ${kindLabel(match.to.kind)}`;
	return match.status;
}

function kindLabel(kind: VersionScopeKind): string {
	return kind === "code" ? "code block" : kind;
}
