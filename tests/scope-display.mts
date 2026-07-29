import assert from "node:assert/strict";
import type { Cst, MicaNode } from "../src/wasm/bridge.ts";
import { buildScopeIndexFromCst, locatorFor, scopeDisplayName } from "../src/ui/versionScopeCore.ts";

const leaf = (text: string): MicaNode => ({ kind: "leaf", text, is_code: false });
const container = (
	name: string,
	title: string,
	open_line: string,
	children: MicaNode[],
	close_line = ":::\n",
): MicaNode => ({ kind: "container", name, title, colons: 3, open_line, children, close_line });
const tab = (title: string, children: MicaNode[]): MicaNode => container("tab", title, `:::tab ${title}\n`, children);
const serialize = (node: MicaNode): string =>
	node.kind === "leaf" ? node.text : node.open_line + node.children.map(serialize).join("") + node.close_line;
const makeIndex = (children: MicaNode[]) => {
	const cst: Cst = { children };
	return buildScopeIndexFromCst(children.map(serialize).join(""), cst);
};
const nameOf = (index: ReturnType<typeof makeIndex>, key: string): string => {
	const scope = index.byKey.get(key);
	assert.ok(scope, `missing scope ${key}`);
	return scopeDisplayName(scope);
};

// The reported case: one tab holding three leaves that all used to render as
// "tab:test", and whose patch headings came out as the first line of content
// ("## code · added", "## n · added").
const index = makeIndex([
	container("tabs", "", ":::tabs\n", [
		tab("test", [
			leaf("```js\nfirst()\n```\n"),
			leaf("\n"),
			leaf("```js\nsecond()\n```\n"),
			leaf("\n"),
			leaf("n\n"),
		]),
	]),
]);

const codes = index.scopes.filter((scope) => scope.kind === "code");
assert.equal(codes.length, 2, "the fixture holds two sibling code blocks in one tab");
assert.deepEqual(
	codes.map((scope) => scopeDisplayName(scope)),
	["Block › Tabs › test › Code block (1 of 2)", "Block › Tabs › test › Code block (2 of 2)"],
	"siblings are told apart by ordinal instead of collapsing to their container",
);

const prose = index.scopes.find((scope) => scope.kind === "section" && !scope.container);
assert.ok(prose);
assert.equal(
	scopeDisplayName(prose),
	"Block › Tabs › test › Section",
	"a lone prose leaf needs no ordinal, and is never named after its content",
);
assert.equal(prose.label, "n", "the fixture's prose leaf really does derive a content label");
assert.equal(
	scopeDisplayName(prose).split(" › ").at(-1),
	"Section",
	"the content-derived label never becomes the element's displayed name",
);

// Containers keep their authored title — that is real location information,
// unlike a leaf's content-derived label.
assert.equal(nameOf(index, "tab:0.0"), "Block › Tabs › test");
assert.equal(nameOf(index, "tabs:0"), "Block › Tabs");
assert.equal(nameOf(index, "block:"), "Block", "the whole block needs no trail");

// A lone child carries no ordinal: "(1 of 1)" is noise, not disambiguation.
const single = makeIndex([container("tabs", "", ":::tabs\n", [tab("only", [leaf("```js\nsolo()\n```\n")])])]);
const onlyCode = single.scopes.find((scope) => scope.kind === "code");
assert.ok(onlyCode);
assert.equal(scopeDisplayName(onlyCode), "Block › Tabs › only › Code block");

// An untitled container falls back to its type rather than rendering an empty
// trailing segment.
const untitled = makeIndex([container("grid", "", ":::grid\n", [container("cell", "", ":::cell\n", [leaf("x\n")])])]);
assert.equal(nameOf(untitled, "grid:0"), "Block › Grid");
assert.equal(nameOf(untitled, "cell:0.0"), "Block › Grid › Cell");

// Matching folds case; display must not. A tab the user called "Main" is not
// called "main" anywhere they can see.
const cased = makeIndex([container("tabs", "", ":::tabs\n", [tab("Main Notes", [leaf("```js\nx()\n```\n")])])]);
assert.equal(nameOf(cased, "tab:0.0"), "Block › Tabs › Main Notes");
const casedCode = cased.scopes.find((scope) => scope.kind === "code");
assert.ok(casedCode);
assert.equal(scopeDisplayName(casedCode), "Block › Tabs › Main Notes › Code block");
assert.equal(cased.byKey.get("tab:0.0")?.label, "main notes", "the matching key stays case-folded");
assert.equal(cased.byKey.get("tab:0.0")?.title, "Main Notes", "display keeps the authored casing");

// A locator stands in for a scope that could not be resolved in the target
// snapshot, and must name it the same way — by where it was.
const locator = locatorFor(codes[1], index);
assert.equal(
	scopeDisplayName(locator),
	"Block › Tabs › test › Code block (2 of 2)",
	"an added or removed element is named identically to a matched one",
);

console.log("scope-display: ok");
