import assert from "node:assert/strict";
import type { Cst, MicaNode } from "../src/wasm/bridge.ts";
import { buildScopeIndexFromCst, locatorFor, resolveScope, scopeSource } from "../src/ui/versionScopeCore.ts";

const leaf = (text: string): MicaNode => ({ kind: "leaf", text, is_code: false });
const container = (
	name: string,
	title: string,
	open_line: string,
	children: MicaNode[],
	close_line = ":::\n",
): MicaNode => ({
	kind: "container",
	name,
	title,
	colons: 3,
	open_line,
	children,
	close_line,
});
const tab = (title: string, text: string): MicaNode => container("tab", title, `:::tab ${title}\n`, [leaf(text)]);
const serialize = (node: MicaNode): string =>
	node.kind === "leaf" ? node.text : node.open_line + node.children.map(serialize).join("") + node.close_line;
const makeIndex = (children: MicaNode[]) => {
	const cst: Cst = { children };
	const source = children.map(serialize).join("");
	return buildScopeIndexFromCst(source, cst);
};

const tabs = container("tabs", "", ":::tabs\n", [tab("Alpha", "first\n"), tab("Beta", "same\n")]);
const grid = container("grid", "{cols=2}", ":::grid {cols=2}\n", [
	container("cell", "", ":::cell\n", [leaf("> [!note] Heads up\n> body\n")]),
	container("cell", "", ":::cell\n", [leaf("```md\n**bold**\n```\n")]),
]);
const index = makeIndex([tabs, grid]);
assert.ok(index.byKey.has("block:"));
assert.ok(index.byKey.has("tabs:0"));
assert.ok(index.byKey.has("tab:0.0"));
assert.ok(index.byKey.has("tab:0.1"));
assert.ok(index.byKey.has("grid:1"));
assert.ok(index.byKey.has("cell:1.0"));
assert.ok(index.scopes.some((scope) => scope.kind === "callout"));
assert.ok(index.scopes.some((scope) => scope.kind === "code"));
for (const scope of index.scopes) assert.equal(scopeSource(index, scope), index.source.slice(scope.start, scope.end));

const beta = index.byKey.get("tab:0.1");
assert.ok(beta);
const insertedBefore = makeIndex([
	container("tabs", "", ":::tabs\n", [tab("New", "new\n"), tab("Alpha", "first\n"), tab("Beta", "same\n")]),
	grid,
]);
const moved = resolveScope(insertedBefore, locatorFor(beta, index));
assert.equal(moved.kind, "exact");
if (moved.kind === "exact") assert.equal(moved.scope.label, "beta");
const renamed = makeIndex([
	container("tabs", "", ":::tabs\n", [tab("Alpha", "first\n"), tab("Renamed", "same\n")]),
	grid,
]);
const renamedMatch = resolveScope(renamed, locatorFor(beta, index));
assert.equal(renamedMatch.kind, "exact", "a unique unchanged body survives a presentation rename");

const ambiguous = makeIndex([
	container("tabs", "", ":::tabs\n", [
		tab("Same", "anchor\n"),
		tab("Same", "x\n"),
		tab("Same", "anchor\n"),
		tab("Same", "y\n"),
		tab("Same", "anchor\n"),
	]),
]);
const changed = makeIndex([
	container("tabs", "", ":::tabs\n", [
		tab("Same", "anchor\n"),
		tab("Same", "changed\n"),
		tab("Same", "anchor\n"),
		tab("Same", "y\n"),
		tab("Same", "anchor\n"),
	]),
]);
const changedTab = changed.byKey.get("tab:0.1");
assert.ok(changedTab);
const result = resolveScope(ambiguous, locatorFor(changedTab, changed));
assert.equal(result.kind, "ambiguous", "numeric path alone must never silently pair a structurally edited object");

const logical = makeIndex([container("section", "", ":::section\n", [leaf("one section\n")])]);
assert.equal(
	logical.scopes.filter((scope) => scope.kind === "section").length,
	1,
	"a rendered logical section has one inspector identity",
);
const logicalScope = logical.byKey.get("section:0");
assert.ok(logicalScope);
assert.equal(resolveScope(logical, locatorFor(logicalScope, logical)).kind, "exact");

// User-authored delimiter characters must never collide in compatible tuple
// keys. These represented different (kind, label, ancestry) tuples under the
// former pipe/slash concatenation.
const delimiterRoot = makeIndex([leaf("x|tabs:tabs/tab:a\n")]);
const delimiterNested = makeIndex([
	container("tabs", "tabs", ":::tabs tabs\n", [container("tab", "a|", ":::tab a|\n", [leaf("x\n")])]),
]);
const delimiterScope = delimiterRoot.scopes.find((scope) => scope.kind === "section");
assert.ok(delimiterScope);
assert.equal(resolveScope(delimiterNested, locatorFor(delimiterScope, delimiterRoot)).kind, "missing");

const duplicateChildren = Array.from({ length: 10_000 }, () => leaf("duplicate\n"));
const duplicates = makeIndex(duplicateChildren);
const duplicateScope = duplicates.scopes.find((scope) => scope.kind === "section");
assert.ok(duplicateScope);
const duplicateResolution = resolveScope(duplicates, locatorFor(duplicateScope, duplicates));
assert.equal(duplicateResolution.kind, "ambiguous");
if (duplicateResolution.kind === "ambiguous") {
	assert.equal(duplicateResolution.candidates.length, 64, "manual candidate rendering remains bounded");
	assert.equal(duplicateResolution.truncated, true);
}

console.log("VERSION SCOPE OK");
