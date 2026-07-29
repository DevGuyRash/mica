import assert from "node:assert/strict";
import { matchingVersions, searchVersions, VERSION_ROW_PAGE_SIZE, versionPageBounds } from "../src/ui/versionWindow.ts";

assert.deepEqual(versionPageBounds(0, 10_000), { start: 0, end: 0 });
assert.deepEqual(versionPageBounds(10_000, 0), { start: 0, end: VERSION_ROW_PAGE_SIZE });
assert.deepEqual(versionPageBounds(10_000, 500), { start: 500, end: 600 });
assert.deepEqual(versionPageBounds(10_005, 99_999), { start: 10_000, end: 10_005 });

const rows = Array.from({ length: 10_000 }, (_, index) => ({
	n: index + 1,
	meta: {
		versionId: `version-${index}`,
		hash: `b3:${index.toString(16).padStart(4, "0").padEnd(64, "0")}`,
		label: index < 2 ? "Shared Release" : `label-${index}`,
		ts: Date.UTC(2026, 0, 1) + index * 86_400_000,
	},
}));
assert.equal(matchingVersions(rows, "v7500")[0]?.n, 7_500);
assert.equal(matchingVersions(rows, rows[4321].meta.hash)[0]?.n, 4_322);
assert.equal(matchingVersions(rows, "shared release").length, 2);
assert.deepEqual(matchingVersions(rows, "missing"), []);
assert.equal(searchVersions(rows, "SHARED", 10).length, 2, "labels search case-insensitively");
assert.equal(searchVersions(rows, "v4322", 10)[0]?.row.meta.hash, rows[4321].meta.hash);
assert.equal(searchVersions(rows, rows[4321].meta.hash.slice(3, 14), 10)[0]?.row.n, 4_322);
assert.ok(searchVersions(rows, "2026-01-03", 10).some((result) => result.row.n === 3));
assert.equal(
	searchVersions(
		[{ n: 1, meta: { versionId: "version-1", hash: "b3:abc", label: "Milestone Alpha" } }],
		"mlstnalpha",
		10,
	)[0]?.row.n,
	1,
	"fuzzy labels are ranked",
);
assert.equal(searchVersions(rows, "", 7).length, 7, "empty search returns a bounded recent window");

const common = Array.from({ length: 10_000 }, (_, index) => ({
	n: index + 1,
	meta: {
		versionId: `common-${index}`,
		hash: `b3:${index.toString(16).padStart(4, "0").padEnd(64, "0")}`,
		label: "common",
	},
}));
assert.equal(matchingVersions(common, "common").length, 2, "ambiguous searches stop after two matches");
const boundedCommon = searchVersions(common, "common", 100);
assert.equal(boundedCommon.length, 100);
assert.equal(boundedCommon[0].row.n, 10_000, "equal-ranked results prefer the newest ordinal");
assert.equal(boundedCommon.at(-1)?.row.n, 9_901, "search retains only its bounded best-result window");

console.log("VERSION WINDOW OK");
