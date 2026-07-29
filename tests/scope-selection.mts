import assert from "node:assert/strict";
import {
	MAX_SELECTED_SCOPES,
	rangeCandidates,
	reconcileScopeSelection,
	selectScope,
	type ScopeSelectionState,
} from "../src/ui/scopeSelection.ts";
import { scopeParentFamilyKey, type ScopeIndex, type VersionScope } from "../src/ui/versionScopeCore.ts";

const scope = (
	key: string,
	parentKey: string | null,
	start: number,
	end: number,
	siblingOrdinal: number,
	label: string,
	kind: VersionScope["kind"] = "section",
): VersionScope => ({
	key,
	kind,
	family: kind === "section" ? "section-family" : kind,
	path: [siblingOrdinal],
	parentKey,
	ancestry: [],
	label,
	title: label,
	titleAncestry: [],
	container: kind === "block" || kind === "tab",
	shape: kind,
	siblingOrdinal,
	siblingCount: 2,
	kindOrdinal: siblingOrdinal,
	kindCount: 2,
	start,
	end,
	fingerprintStart: start,
	fingerprintEnd: end,
	signature: key,
	previousSignature: null,
	nextSignature: null,
	previousKey: null,
	nextKey: null,
});
const scopes = [
	scope("block:", null, 0, 100, 0, "block", "block"),
	scope("tab:one", "block:", 0, 60, 0, "one", "tab"),
	scope("section:a", "tab:one", 5, 20, 0, "alpha"),
	scope("section:b", "tab:one", 21, 40, 1, "beta"),
	scope("tab:two", "block:", 61, 100, 1, "two", "tab"),
	scope("section:c", "tab:two", 65, 90, 0, "gamma"),
];
const byParentFamily = new Map<string, VersionScope[]>();
for (const candidate of scopes) {
	const key = scopeParentFamilyKey(candidate.parentKey, candidate.family);
	const siblings = byParentFamily.get(key);
	if (siblings) siblings.push(candidate);
	else byParentFamily.set(key, [candidate]);
}
const index = {
	source: "",
	scopes,
	byKey: new Map(scopes.map((candidate) => [candidate.key, candidate])),
	bySignature: new Map(),
	byCompatible: new Map(),
	byFamily: new Map(),
	byParentFamily,
} satisfies ScopeIndex;
const sections = index.scopes.filter((scope) => scope.kind === "section");
assert.equal(sections.length, 3);

// --- One mode: modifiers extend, but never take the mode over ---------------

let state: ScopeSelectionState = { mode: "one", keys: ["block:"], anchor: "block:" };
let result = selectScope(state, index, sections[0].key);
assert.equal(result.ok, true);
if (result.ok) state = result.state;
assert.deepEqual(state.keys, [sections[0].key]);

result = selectScope(state, index, sections[1].key, { toggle: true });
assert.equal(result.ok, true);
if (result.ok) state = result.state;
assert.deepEqual(state.keys, [sections[0].key, sections[1].key]);
assert.equal(state.mode, "one", "a held modifier does not silently promote the click mode");

result = selectScope(state, index, sections[0].key);
assert.equal(result.ok, true);
if (result.ok) state = result.state;
assert.deepEqual(
	state.keys,
	[sections[0].key],
	"after a Ctrl-click, an unmodified click still replaces — Ctrl keeps meaning what it meant",
);

result = selectScope(state, index, sections[0].key, { toggle: true });
assert.equal(result.ok, true);
if (result.ok) state = result.state;
assert.deepEqual(state.keys, [], "Ctrl-clicking the only selected element clears it");

// --- Multiple mode: a plain tap accumulates, for pointers with no modifiers --

state = { mode: "multiple", keys: [], anchor: null };
for (const section of [sections[0], sections[1]]) {
	result = selectScope(state, index, section.key);
	assert.equal(result.ok, true);
	if (result.ok) state = result.state;
}
assert.deepEqual(state.keys, [sections[0].key, sections[1].key], "plain taps accumulate in Multiple mode");
assert.equal(state.mode, "multiple", "the explicit mode survives selection changes");

result = selectScope(state, index, sections[0].key);
assert.equal(result.ok, true);
if (result.ok) state = result.state;
assert.deepEqual(state.keys, [sections[1].key], "plain tap toggles in Multiple mode");

result = selectScope(state, index, sections[1].key);
assert.equal(result.ok, true);
if (result.ok) state = result.state;
assert.deepEqual(state.keys, [], "Multiple mode can have an empty selection");
assert.deepEqual(
	reconcileScopeSelection(state, index).keys,
	[],
	"reconciliation preserves an intentional empty selection",
);

result = selectScope(state, index, sections[0].key);
assert.equal(result.ok, true);
if (result.ok) state = result.state;
result = selectScope(state, index, sections[1].key);
assert.equal(result.ok, true);
if (result.ok) state = result.state;

// --- Ranges span siblings only, and say so before the click -----------------

const invalid = selectScope(state, index, sections[2].key, { range: true, additive: true });
assert.equal(invalid.ok, false, "a range across two different tabs has no meaningful order");
assert.deepEqual(invalid.state.keys, state.keys, "a refused range leaves the selection untouched");

assert.deepEqual(
	rangeCandidates({ mode: "multiple", keys: [], anchor: sections[0].key }, index),
	new Set([sections[0].key, sections[1].key]),
	"the UI can show which elements Shift can reach without provoking a refusal",
);
assert.equal(
	rangeCandidates({ mode: "multiple", keys: [], anchor: sections[0].key }, index).has(sections[2].key),
	false,
	"a sibling in another container is not reachable",
);
assert.deepEqual(
	rangeCandidates({ mode: "multiple", keys: [], anchor: null }, index),
	new Set(),
	"with no anchor there is nothing to extend from",
);

const ranged = selectScope({ mode: "multiple", keys: [], anchor: sections[0].key }, index, sections[1].key, {
	range: true,
});
assert.equal(ranged.ok, true);
if (ranged.ok) assert.deepEqual(ranged.state.keys, [sections[0].key, sections[1].key], "Shift spans the sibling run");

const tab = index.scopes.find((scope) => scope.kind === "tab" && scope.label === "one")!;
result = selectScope(state, index, tab.key, { toggle: true });
assert.equal(result.ok, true);
if (result.ok) state = result.state;
assert.deepEqual(state.keys, [tab.key], "selecting a parent removes selected descendants");

const oversized = {
	...index,
	scopes: Array.from({ length: MAX_SELECTED_SCOPES + 1 }, (_, position) => ({
		...sections[0],
		key: `section:test:${position}`,
		start: position * 10,
		end: position * 10 + 5,
		siblingOrdinal: position,
		siblingCount: MAX_SELECTED_SCOPES + 1,
	})),
};
oversized.byKey = new Map(oversized.scopes.map((scope) => [scope.key, scope]));
oversized.byParentFamily = new Map([
	[scopeParentFamilyKey(sections[0].parentKey, sections[0].family), oversized.scopes],
]);
const capped = selectScope(
	{ mode: "multiple", keys: oversized.scopes.slice(0, MAX_SELECTED_SCOPES).map((scope) => scope.key), anchor: null },
	oversized,
	oversized.scopes.at(-1)!.key,
	{ toggle: true },
);
assert.equal(capped.ok, false);

console.log("SCOPE SELECTION OK");
