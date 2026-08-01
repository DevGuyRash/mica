import assert from "node:assert/strict";
import { combineKindOf, combineNeedsMixed, regionKind, type CombineKind } from "../src/ui/dnd.ts";

// --- what a leaf holds ------------------------------------------------------

assert.equal(combineKindOf("Some prose.\n"), "markdown");
assert.equal(combineKindOf("> [!tip] Hello\n> A callout.\n"), "callout");
assert.equal(combineKindOf("```js\nconst a = 1;\n```\n"), "code");
assert.equal(combineKindOf("~~~\nfenced with tildes\n~~~\n"), "code");
assert.equal(
	combineKindOf("still code\n", true),
	"code",
	"a leaf the parser already marked as code is code regardless of its text",
);

assert.equal(combineKindOf(""), null, "blank text is scaffolding, not content");
assert.equal(combineKindOf("   \n\n\t\n"), null, "whitespace-only text is scaffolding, not content");

// A callout whose body contains a fence is still a callout: the outer marker is
// what a merge would dissolve.
assert.equal(combineKindOf("> [!note] Wrapped\n> ```\n> code\n> ```\n"), "callout");

// --- what a region holds ----------------------------------------------------

assert.equal(regionKind(["markdown", "markdown"]), "markdown");
assert.equal(regionKind([null, "markdown", null]), "markdown", "blank leaves do not decide the kind");
assert.equal(regionKind([]), null, "a region with no content leaf has no kind and cannot combine");
assert.equal(regionKind([null, null]), null, "a wholly blank region has no kind");
assert.equal(
	regionKind(["markdown", "callout"]),
	"callout",
	"a region is named by what merging it would dissolve, not by its majority",
);
assert.equal(regionKind(["code", "markdown"]), "code");
assert.equal(
	regionKind(["callout", "code"]),
	"callout",
	"the first structural part decides the name; both need the same permission",
);

// --- when the reducer's mixed permission is required ------------------------
//
// This is the invariant that keeps a menu label honest: the plain and the
// "as Markdown" merge produced byte-identical results whenever every part was
// already prose, which is why offering both was a choice that was not one.

assert.equal(combineNeedsMixed(["markdown", "markdown"]), false);
assert.equal(combineNeedsMixed(["markdown", "callout"]), true);
assert.equal(combineNeedsMixed(["callout", "markdown"]), true);
assert.equal(combineNeedsMixed(["code", "code"]), true, "two fences still dissolve into one section");
assert.equal(combineNeedsMixed([]), false);

// A run's permission is the union of its parts, so one callout in the middle of
// a prose run is enough to require it.
const run: CombineKind[] = ["markdown", "markdown", "callout", "markdown"];
assert.equal(combineNeedsMixed(run), true);
assert.equal(combineNeedsMixed(run.filter((kind) => kind === "markdown")), false);

console.log("combine-kind: ok");
