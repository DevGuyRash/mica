import assert from "node:assert/strict";
import { buildVersionBaseIndex, resolveVersionBase } from "../src/ui/versionBase.ts";

const rows = [
	{ n: 3, head: true, meta: { versionId: "branch", hash: "branch", effectiveParentVersionId: "root" } },
	{ n: 2, head: false, meta: { versionId: "linear", hash: "linear", effectiveParentVersionId: "root" } },
	{ n: 1, head: false, meta: { versionId: "root", hash: "root", effectiveParentVersionId: null } },
];

assert.deepEqual(resolveVersionBase(rows, "__working__", "auto", "__working__", "__empty__"), {
	key: "branch",
	autoReason: "current-head",
});
assert.deepEqual(resolveVersionBase(rows, "branch", "auto", "__working__", "__empty__"), {
	key: "root",
	autoReason: "parent",
});
assert.deepEqual(resolveVersionBase(rows, "root", "auto", "__working__", "__empty__"), {
	key: "__empty__",
	autoReason: "before-first",
});
assert.deepEqual(
	resolveVersionBase(
		[
			...rows,
			{
				n: 4,
				head: false,
				meta: {
					versionId: "migrated-branch-root",
					hash: "migrated-branch-root",
					effectiveParentVersionId: null,
					lineageRoot: true,
				},
			},
		],
		"migrated-branch-root",
		"auto",
		"__working__",
		"__empty__",
	),
	{ key: "__empty__", autoReason: "before-first" },
	"an explicit migrated branch root remains a root even when dense visible numbering is greater than one",
);
assert.deepEqual(
	resolveVersionBase(
		[{ n: 2, head: true, meta: { versionId: "legacy", hash: "legacy", effectiveParentVersionId: null } }],
		"legacy",
		"auto",
		"__working__",
		"__empty__",
	),
	{ key: "__empty__", autoReason: "unavailable-parent" },
	"a non-root legacy version must not masquerade as the first version",
);
assert.deepEqual(resolveVersionBase(rows, "branch", "head", "__working__", "__empty__"), { key: "branch" });
assert.deepEqual(resolveVersionBase(rows, "branch", "linear", "__working__", "__empty__"), { key: "linear" });
const baseIndex = buildVersionBaseIndex(rows);
assert.deepEqual(resolveVersionBase(rows, "branch", "auto", "__working__", "__empty__", baseIndex), {
	key: "root",
	autoReason: "parent",
});
assert.deepEqual(resolveVersionBase([], "__working__", "auto", "__working__", "__empty__"), {
	key: "__empty__",
	autoReason: "before-first",
});

console.log("VERSION BASE OK");
