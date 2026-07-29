import assert from "node:assert/strict";
import {
	buildVersionParentIndex,
	versionLineageRoute,
	versionLineageRouteFromParents,
} from "../src/ui/versionLineage.ts";

const rows = [
	{ n: 1, meta: { versionId: "root", hash: "root", effectiveParentVersionId: null } },
	{ n: 2, meta: { versionId: "a", hash: "a", effectiveParentVersionId: "root" } },
	{ n: 3, meta: { versionId: "b", hash: "b", effectiveParentVersionId: "a" } },
	{ n: 4, meta: { versionId: "branch", hash: "branch", effectiveParentVersionId: "a" } },
];

assert.deepEqual(versionLineageRoute(rows, "root", "b", "working", "b"), [
	{ parent: "root", child: "a", direction: "forward" },
	{ parent: "a", child: "b", direction: "forward" },
]);
assert.deepEqual(versionLineageRoute(rows, "b", "branch", "working", "b"), [
	{ parent: "a", child: "b", direction: "backward" },
	{ parent: "a", child: "branch", direction: "forward" },
]);
assert.deepEqual(versionLineageRoute(rows, "a", "working", "working", "b"), [
	{ parent: "a", child: "b", direction: "forward" },
	{ parent: "b", child: "working", direction: "forward" },
]);
assert.equal(versionLineageRoute(rows, "missing", "b", "working", "b"), null);
assert.equal(versionLineageRoute(rows, "root", "b", "working", "b", 1), null);
assert.deepEqual(versionLineageRouteFromParents(buildVersionParentIndex(rows, "working", "b"), "b", "branch"), [
	{ parent: "a", child: "b", direction: "backward" },
	{ parent: "a", child: "branch", direction: "forward" },
]);

const longRows = Array.from({ length: 151 }, (_, index) => ({
	n: index + 1,
	meta: {
		versionId: `long-${index}`,
		hash: `hash-${index}`,
		effectiveParentVersionId: index ? `long-${index - 1}` : null,
	},
}));
const longRoute = versionLineageRoute(longRows, "long-0", "long-150", "working", "long-150");
assert.ok(longRoute);
assert.equal(longRoute.length, 150, "histories longer than one timeline page retain their actual route");
assert.deepEqual(longRoute.at(-1), {
	parent: "long-149",
	child: "long-150",
	direction: "forward",
});

console.log("VERSION LINEAGE OK");
