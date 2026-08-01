import assert from "node:assert/strict";
import {
	describePlan,
	MAX_COMPARISON_COLUMNS,
	planCells,
	planComparison,
	planKeys,
	type ComparisonTarget,
} from "../src/ui/comparisonPlan.ts";

/** `vN` ranks as N, so these fixtures carry real chronology and the layout rule
 * is exercised by every case rather than only the ones written for it. */
const target = (key: string, label = key): ComparisonTarget => ({
	key,
	label,
	order: Number(/\d+/.exec(key)?.[0] ?? 0),
});
const element = (id: string, name = id): { id: string; name: string } => ({ id, name });

// --- pair degradation ------------------------------------------------------

const pair = planComparison({
	base: target("v15"),
	picks: [],
	selected: target("v16"),
	elements: [],
});
assert.equal(pair.kind, "pair");
assert.deepEqual(
	pair.targets.map((entry) => entry.key),
	["v16"],
	"with nothing picked the plan compares the selected version",
);
assert.equal(pair.droppedBase, null);

assert.deepEqual(
	planComparison({ base: target("v16"), picks: [], selected: target("v16"), elements: [] }).targets.map(
		(entry) => entry.key,
	),
	["v16"],
	"pinning the version being viewed is a self-comparison the user asked for, not an empty surface",
);

// --- the base is never also a column ---------------------------------------

const withBasePicked = planComparison({
	base: target("v16"),
	picks: [target("v16"), target("v15"), target("v14")],
	selected: target("v16"),
	elements: [],
});
assert.equal(withBasePicked.kind, "multi");
assert.deepEqual(
	withBasePicked.targets.map((entry) => entry.key),
	["v14", "v15"],
	"the base never renders as one of its own comparison columns",
);
assert.equal(withBasePicked.droppedBase?.key, "v16", "dropping the base is reported, not silent");

assert.equal(
	planComparison({
		base: target("v16"),
		picks: [target("v16")],
		selected: target("v16"),
		elements: [],
	}).kind,
	"pair",
	"picking only the base leaves nothing to compare against it, so the plan degrades to a pair",
);

assert.deepEqual(
	planComparison({
		base: target("v16"),
		picks: [target("v15"), target("v15"), target("v14")],
		selected: target("v16"),
		elements: [],
	}).targets.map((entry) => entry.key),
	["v14", "v15"],
	"a duplicated pick contributes one column",
);

// --- columns read forwards in time -----------------------------------------
//
// The timeline hands picks over newest first. Laying them out in that order
// makes a diff read backwards, so display is chronological regardless of how
// the picks arrived.

assert.deepEqual(
	planComparison({
		base: target("v16"),
		picks: [target("v15"), target("v13"), target("v14")],
		selected: target("v16"),
		elements: [],
	}).targets.map((entry) => entry.key),
	["v13", "v14", "v15"],
	"columns are laid out oldest to newest whatever order the picks arrive in",
);

const ties = planComparison({
	base: { key: "base", label: "base", order: 0 },
	picks: [
		{ key: "b", label: "b", order: 5 },
		{ key: "a", label: "a", order: 5 },
	],
	selected: { key: "base", label: "base", order: 0 },
	elements: [],
});
assert.deepEqual(
	ties.targets.map((entry) => entry.key),
	["b", "a"],
	"equal ranks keep their incoming order rather than shuffling between renders",
);

// --- column overflow is reported, never silently truncated ------------------

const many = ["v15", "v14", "v13", "v12", "v11", "v10"].map((key) => target(key));
const capped = planComparison({ base: target("v16"), picks: many, selected: target("v16"), elements: [] });
assert.equal(capped.targets.length, MAX_COMPARISON_COLUMNS);
assert.deepEqual(
	capped.targets.map((entry) => entry.key),
	["v12", "v13", "v14", "v15"],
	"inclusion follows the order the timeline offered; only the layout is chronological",
);
assert.deepEqual(
	capped.overflow.map((entry) => entry.key),
	["v10", "v11"],
	"targets beyond the column budget are named so the UI can say what it dropped",
);

const uncapped = planComparison({
	base: target("v16"),
	picks: many,
	selected: target("v16"),
	elements: [],
	columnCap: Number.POSITIVE_INFINITY,
});
assert.equal(uncapped.targets.length, 6, "stacked layouts have no column budget");
assert.deepEqual(
	uncapped.targets.map((entry) => entry.key),
	["v10", "v11", "v12", "v13", "v14", "v15"],
	"lifting the cap keeps the chronological layout",
);
assert.deepEqual(uncapped.overflow, [], "nothing overflows when the cap is lifted");

// --- cells are element-major and match display order ------------------------

const composed = planComparison({
	base: target("v16"),
	picks: [target("v15"), target("v14")],
	selected: target("v16"),
	elements: [element("a"), element("b")],
});
assert.deepEqual(
	planCells(composed).map((cell) => `${cell.element?.id}@${cell.target.key}`),
	["a@v14", "a@v15", "b@v14", "b@v15"],
	"each focused element owns a row spanning every target, in that order",
);
assert.deepEqual(
	planCells(composed).map((cell) => [cell.elementIndex, cell.targetIndex]),
	[
		[0, 0],
		[0, 1],
		[1, 0],
		[1, 1],
	],
);

const wholeBlock = planCells(pair);
assert.equal(wholeBlock.length, 1);
assert.equal(wholeBlock[0].element, null, "an unfocused comparison yields one whole-block cell");
assert.equal(wholeBlock[0].elementIndex, -1);

// Overflow must not leak into the cells: copy walks the same list the renderer
// paints, so an undisplayed version must not silently reach the clipboard.
assert.deepEqual(
	planCells(capped).map((cell) => cell.target.key),
	["v12", "v13", "v14", "v15"],
	"copy covers exactly the displayed targets, in the order they are displayed",
);

// --- keys and description ---------------------------------------------------

assert.deepEqual(planKeys(composed), ["v16", "v14", "v15"], "the base is loaded alongside every target");
assert.deepEqual(
	planKeys(planComparison({ base: target("v16"), picks: [], selected: target("v16"), elements: [] })),
	["v16"],
	"a self-comparison needs one snapshot loaded, not two",
);

assert.equal(describePlan(pair), "v15 → v16");
assert.equal(describePlan(composed), "2 elements · v16 → v14, v15");
assert.equal(
	describePlan(
		planComparison({
			base: target("v15"),
			picks: [],
			selected: target("v16"),
			elements: [element("a", "Tabs › test › Code block (2 of 3)")],
		}),
	),
	"Tabs › test › Code block (2 of 3) · v15 → v16",
	"a single focused element is named outright rather than counted",
);

console.log("comparison-plan: ok");
