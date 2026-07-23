import assert from "node:assert/strict";
import { packResponsiveActions, type ResponsiveActionCandidate } from "../src/ui/responsiveActions.ts";

const actions: ResponsiveActionCandidate[] = [
	{ id: "copy", width: 30, directPriority: 0 },
	{ id: "edit", width: 30, directPriority: 1 },
	{ id: "convert", width: 30, directPriority: 3 },
	{ id: "delete", width: 30, directPriority: 4 },
	{ id: "details", width: 30, overflowOnly: true },
];

assert.deepEqual(packResponsiveActions(actions, 158, 2, 30), {
	direct: ["copy", "edit", "convert", "delete"],
	overflow: ["details"],
});
assert.deepEqual(packResponsiveActions(actions, 157, 2, 30), {
	direct: ["copy", "edit", "convert"],
	overflow: ["delete", "details"],
});
assert.deepEqual(packResponsiveActions(actions, 30, 2, 30), {
	direct: [],
	overflow: ["copy", "edit", "convert", "delete", "details"],
});
assert.deepEqual(packResponsiveActions(actions, 500, 2, 30, true), {
	direct: [],
	overflow: ["copy", "edit", "convert", "delete", "details"],
});

const pinned: ResponsiveActionCandidate[] = [
	{ id: "drag", width: 30, pinned: true },
	{ id: "copy", width: 30, directPriority: 0 },
	{ id: "delete", width: 30, directPriority: 4 },
];
assert.deepEqual(packResponsiveActions(pinned, 62, 2, 30), {
	direct: ["drag"],
	overflow: ["copy", "delete"],
});
assert.deepEqual(packResponsiveActions(pinned, 84, 2, 20), {
	direct: ["drag", "copy"],
	overflow: ["delete"],
});

const reordered: ResponsiveActionCandidate[] = [
	{ id: "delete", width: 30, directPriority: 4 },
	{ id: "copy", width: 30, directPriority: 0 },
	{ id: "edit", width: 30, directPriority: 1 },
];
assert.deepEqual(packResponsiveActions(reordered, 62, 2, 30), {
	direct: ["copy"],
	overflow: ["delete", "edit"],
});

console.log("RESPONSIVE ACTIONS OK");
