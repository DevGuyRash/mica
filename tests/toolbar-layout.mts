import assert from "node:assert/strict";
import { normalizeToolbarLayout, packToolbarEntries } from "../src/ui/toolbarLayout";

const available = new Set(["a", "b", "code"]);
assert.deepEqual(
	normalizeToolbarLayout(["|", "a", "|", "missing", "|", "b", "|"], (id) => (available.has(id) ? id : null)),
	[{ kind: "tool", value: "a" }, { kind: "separator" }, { kind: "tool", value: "b" }],
	"surface filtering must happen before separator normalization",
);
assert.deepEqual(
	normalizeToolbarLayout(["bold", "|", "code", "|", "italic"], (id) => (id === "code" ? id : null)),
	[{ kind: "tool", value: "code" }],
	"a code-only ribbon must not retain orphan separators",
);
assert.deepEqual(
	normalizeToolbarLayout(["bold", "|", "italic"], () => null),
	[],
	"an empty surface must produce no ribbon chrome",
);

const entries = [
	{ kind: "tool" as const, width: 30 },
	{ kind: "separator" as const, width: 15 },
	{ kind: "tool" as const, width: 30 },
];
assert.deepEqual(packToolbarEntries(entries, 84, 30, 5), {
	direct: [true, false, false],
	overflow: [false, false, true],
	showMore: true,
});
assert.deepEqual(packToolbarEntries(entries, 65, 30, 5), {
	direct: [true, false, false],
	overflow: [false, false, true],
	showMore: true,
});
assert.deepEqual(packToolbarEntries(entries, 64, 30, 5), {
	direct: [false, false, false],
	overflow: [true, false, true],
	showMore: true,
});
assert.deepEqual(packToolbarEntries(entries, 85, 30, 5), {
	direct: [true, true, true],
	overflow: [false, false, false],
	showMore: false,
});
assert.deepEqual(packToolbarEntries(entries, 29, 30, 5), {
	direct: [false, false, false],
	overflow: [true, false, true],
	showMore: true,
});

console.log("toolbar layout tests passed");
