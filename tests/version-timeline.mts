import assert from "node:assert/strict";
import {
	mergeTimelineRows,
	nextPickedSelection,
	partitionPicked,
	type TimelineRow,
} from "../src/ui/versionTimeline.ts";

const row = (versionId: string, originalIndex: number, removed = false): TimelineRow => ({
	meta: { versionId },
	originalIndex,
	removed,
});

/** Rows arrive newest-first, so a fixture is written that way too. */
const newestFirst = (...rows: TimelineRow[]): TimelineRow[] =>
	[...rows].sort((left, right) => right.originalIndex - left.originalIndex);
const ids = (rows: readonly TimelineRow[]): string[] => rows.map((entry) => entry.meta.versionId);

// --- merging removed checkpoints back into place ---------------------------

const live = newestFirst(row("e", 4), row("c", 2), row("a", 0));
const removed = newestFirst(row("d", 3, true), row("b", 1, true));

assert.deepEqual(
	ids(mergeTimelineRows(live, removed)),
	["e", "d", "c", "b", "a"],
	"removed checkpoints land in their chronological slots, not at the end",
);
assert.deepEqual(ids(mergeTimelineRows(live, [])), ["e", "c", "a"], "no removed rows leaves the timeline untouched");
assert.deepEqual(ids(mergeTimelineRows([], removed)), ["d", "b"], "an all-removed history still renders in order");
assert.deepEqual(mergeTimelineRows([], []), []);

assert.deepEqual(
	ids(mergeTimelineRows(newestFirst(row("a", 0)), newestFirst(row("z", 9, true)))),
	["z", "a"],
	"a removed checkpoint newer than everything live sorts first",
);
assert.deepEqual(
	ids(mergeTimelineRows(newestFirst(row("z", 9)), newestFirst(row("a", 0, true)))),
	["z", "a"],
	"a removed checkpoint older than everything live sorts last",
);
assert.deepEqual(
	ids(mergeTimelineRows(newestFirst(row("d", 3), row("c", 2)), newestFirst(row("b", 1, true), row("a", 0, true)))),
	["d", "c", "b", "a"],
	"consecutive removed runs stay contiguous",
);

// The merge must never drop or duplicate a checkpoint, whatever the shape.
for (let mask = 0; mask < 1 << 6; mask++) {
	const all = Array.from({ length: 6 }, (_, index) => row(`v${index}`, index, Boolean(mask & (1 << index))));
	const liveRows = newestFirst(...all.filter((entry) => !entry.removed));
	const removedRows = newestFirst(...all.filter((entry) => entry.removed));
	const merged = mergeTimelineRows(liveRows, removedRows);
	assert.equal(merged.length, all.length, `mask ${mask}: every checkpoint survives the merge`);
	assert.deepEqual(new Set(ids(merged)).size, all.length, `mask ${mask}: no checkpoint is duplicated`);
	assert.deepEqual(
		merged.map((entry) => entry.originalIndex),
		[...merged.map((entry) => entry.originalIndex)].sort((left, right) => right - left),
		`mask ${mask}: the merged timeline stays in chronological order`,
	);
}

assert.deepEqual(ids(live), ["e", "c", "a"], "merging does not mutate its inputs");
assert.deepEqual(ids(removed), ["d", "b"]);

// --- what a checkbox activation selects -------------------------------------

const order = ["v5", "v4", "v3", "v2", "v1"];
const positionOf = (versionId: string): number => order.indexOf(versionId);
const idAt = (position: number): string | null => order[position] ?? null;
const pick = (
	picked: string[],
	versionId: string,
	anchor: string | null = null,
	modifiers: { shift?: boolean; additive?: boolean } = {},
): { picked: string[]; anchor: string } => {
	const result = nextPickedSelection({
		picked: new Set(picked),
		anchor,
		versionId,
		positionOf,
		idAt,
		...modifiers,
	});
	return { picked: [...result.picked], anchor: result.anchor };
};

assert.deepEqual(pick([], "v3"), { picked: ["v3"], anchor: "v3" }, "a plain click selects one checkpoint");
assert.deepEqual(pick(["v3"], "v3"), { picked: [], anchor: "v3" }, "clicking a selected checkpoint clears it");
assert.deepEqual(
	pick(["v3"], "v1"),
	{ picked: ["v3", "v1"], anchor: "v1" },
	"checkboxes accumulate without a modifier — they are checkboxes",
);

assert.deepEqual(
	pick([], "v2", "v4", { shift: true }).picked,
	["v4", "v3", "v2"],
	"Shift spans the run between anchor and target, in timeline order",
);
assert.deepEqual(
	pick([], "v4", "v2", { shift: true }).picked,
	["v4", "v3", "v2"],
	"the span is the same whichever end is clicked first",
);
assert.deepEqual(
	pick(["v1"], "v4", "v5", { shift: true }).picked,
	["v5", "v4"],
	"Shift alone replaces the previous selection",
);
assert.deepEqual(
	pick(["v1"], "v4", "v5", { shift: true, additive: true }).picked,
	["v1", "v5", "v4"],
	"Shift with Ctrl extends instead of replacing",
);
assert.deepEqual(pick([], "v3", "v3", { shift: true }).picked, ["v3"], "a zero-length span selects the one checkpoint");

assert.deepEqual(
	pick(["v2"], "v4", null, { shift: true }),
	{ picked: ["v2", "v4"], anchor: "v4" },
	"Shift with no anchor yet is an ordinary toggle",
);
assert.deepEqual(
	pick([], "gone", "v3", { shift: true }),
	{ picked: ["gone"], anchor: "gone" },
	"a range to a checkpoint that has left the timeline degrades to a toggle rather than selecting a hidden span",
);
assert.deepEqual(
	pick([], "v3", "gone", { shift: true }),
	{ picked: ["v3"], anchor: "v3" },
	"a range from a stale anchor degrades the same way",
);

const source = new Set(["v1"]);
nextPickedSelection({ picked: source, anchor: null, versionId: "v2", positionOf, idAt });
assert.deepEqual([...source], ["v1"], "selection is returned, never mutated in place");

// --- bulk actions act on what they can reach --------------------------------

const gone = new Set(["v2", "v4"]);
assert.deepEqual(
	partitionPicked(new Set(["v1", "v2", "v3", "v4"]), (id) => gone.has(id)),
	{
		live: ["v1", "v3"],
		removed: ["v2", "v4"],
	},
);
assert.deepEqual(
	partitionPicked(new Set(), () => false),
	{ live: [], removed: [] },
);
assert.deepEqual(
	partitionPicked(new Set(["v2"]), (id) => gone.has(id)),
	{
		live: [],
		removed: ["v2"],
	},
);

console.log("version-timeline: ok");
