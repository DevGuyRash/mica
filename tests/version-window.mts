import assert from "node:assert/strict";
import { matchingVersions, VERSION_ROW_PAGE_SIZE, versionPageBounds } from "../src/ui/versionWindow.ts";

assert.deepEqual(versionPageBounds(0, 10_000), { start: 0, end: 0 });
assert.deepEqual(versionPageBounds(10_000, 0), { start: 0, end: VERSION_ROW_PAGE_SIZE });
assert.deepEqual(versionPageBounds(10_000, 500), { start: 500, end: 600 });
assert.deepEqual(versionPageBounds(10_005, 99_999), { start: 10_000, end: 10_005 });

const rows = Array.from({ length: 10_000 }, (_, index) => ({
	n: index + 1,
	meta: { hash: `b3:${index.toString(16).padStart(64, "0")}`, label: index < 2 ? "shared" : `label-${index}` },
}));
assert.equal(matchingVersions(rows, "v7500")[0]?.n, 7_500);
assert.equal(matchingVersions(rows, rows[4321].meta.hash)[0]?.n, 4_322);
assert.equal(matchingVersions(rows, "shared").length, 2);
assert.deepEqual(matchingVersions(rows, "missing"), []);

const common = Array.from({ length: 10_000 }, (_, index) => ({
	n: index + 1,
	meta: { hash: `b3:${index.toString(16).padStart(64, "0")}`, label: "common" },
}));
assert.equal(matchingVersions(common, "common").length, 2, "ambiguous searches stop after two matches");

console.log("VERSION WINDOW OK");
