import assert from "node:assert/strict";
import type { Cst, MicaNode } from "../src/wasm/bridge.ts";
import { buildScopeIndexFromCst } from "../src/ui/versionScopeCore.ts";
import { buildScopeTransition, contentResemblance, resolveSelectedTransition } from "../src/ui/versionTransition.ts";

const leaf = (text: string): MicaNode => ({ kind: "leaf", text, is_code: false });
const container = (
	name: string,
	title: string,
	children: MicaNode[],
	open = `:::${name}${title ? ` ${title}` : ""}\n`,
): MicaNode => ({
	kind: "container",
	name,
	title,
	colons: 3,
	open_line: open,
	children,
	close_line: ":::\n",
});
const tab = (title: string, children: MicaNode[] | string): MicaNode =>
	container("tab", title, typeof children === "string" ? [leaf(children)] : children);
const cell = (children: MicaNode[] | string): MicaNode =>
	container("cell", "", typeof children === "string" ? [leaf(children)] : children);
const serialize = (node: MicaNode): string =>
	node.kind === "leaf" ? node.text : node.open_line + node.children.map(serialize).join("") + node.close_line;
const index = (children: MicaNode[]) => {
	const cst: Cst = { children };
	return buildScopeIndexFromCst(children.map(serialize).join(""), cst);
};

// A normal edit preserves the container and child identities.
const baseTabs = index([container("tabs", "", [tab("Alpha", "hello stable world\n")])]);
const editedTabs = index([container("tabs", "", [tab("Alpha", "hello changed world\n")])]);
const editTransition = buildScopeTransition(baseTabs, editedTabs);
assert.equal(editTransition.reverse.get("tab:0.0")?.from.key, "tab:0.0");
assert.equal(editTransition.reverse.get("section:0.0:0-1")?.status, "changed");

// Inserting a genuinely new tab does not steal the identity of an existing one.
const insertedTabs = index([container("tabs", "", [tab("New", "brand new\n"), tab("Alpha", "hello changed world\n")])]);
const insertTransition = buildScopeTransition(editedTabs, insertedTabs);
assert.equal(insertTransition.reverse.get("tab:0.1")?.from.key, "tab:0.0");
assert.ok(insertTransition.added.has("tab:0.0"), "the inserted tab is classified as added");

// Same-title total replacement remains ambiguous: a path or label is not proof.
const replacedTabs = index([container("tabs", "", [tab("Alpha", "unrelated replacement\n")])]);
const replacement = buildScopeTransition(baseTabs, replacedTabs);
assert.equal(replacement.reverse.has("tab:0.0"), false);
assert.ok(replacement.ambiguousTo.has("tab:0.0"), "a plausible same-label predecessor requires matching");

const renamedTabs = index([container("tabs", "", [tab("Renamed Alpha", "hello stable world\n")])]);
const renamed = buildScopeTransition(baseTabs, renamedTabs);
assert.equal(renamed.reverse.get("tab:0.0")?.from.key, "tab:0.0");
assert.equal(renamed.reverse.get("tab:0.0")?.status, "changed", "metadata-only renames are not unchanged");

const unrelatedGroup = index([container("tabs", "", [tab("Unrelated", "completely different material\n")])]);
const unrelated = buildScopeTransition(baseTabs, unrelatedGroup);
assert.equal(unrelated.reverse.has("tabs:0"), false, "container shape alone cannot authorize identity");
assert.ok(unrelated.ambiguousTo.has("tabs:0"), "a structurally plausible replacement remains explicit");

// Moving an unchanged scope survives a sibling insertion by exact identity.
const movedBase = index([leaf("first\n\n"), leaf("target body\n\n"), leaf("last\n")]);
const movedTo = index([leaf("new\n\n"), leaf("first\n\n"), leaf("last\n\n"), leaf("target body\n")]);
const moved = buildScopeTransition(movedBase, movedTo);
const target = movedTo.scopes.find((scope) => scope.kind === "section" && scope.label === "target body");
assert.ok(target);
assert.equal(moved.reverse.get(target.key)?.from.label, "target body");

// Section-family conversions may match through parent continuity plus nearly
// identical semantic content, while preserving the conversion status.
const markdown = index([leaf("Shared body text stays intact.\n")]);
const callout = index([leaf("> [!note]\n> Shared body text stays intact.\n")]);
const converted = buildScopeTransition(markdown, callout);
const calloutScope = callout.scopes.find((scope) => scope.kind === "callout");
assert.ok(calloutScope);
assert.equal(converted.reverse.get(calloutScope.key)?.status, "converted");

// Combining and splitting adjacent sections are explicit transformations.
const separate = index([leaf("Alpha paragraph.\n\n"), leaf("Beta paragraph.\n")]);
const combined = index([container("section", "", [leaf("Alpha paragraph.\n\n"), leaf("Beta paragraph.\n")])]);
const combineTransition = buildScopeTransition(separate, combined);
assert.equal(combineTransition.combinedTo.get("section:0")?.length, 2);
const combinedOutcome = resolveSelectedTransition(combineTransition, combined.byKey.get("section:0")!);
assert.equal(combinedOutcome.kind, "exact");
assert.equal(
	combinedOutcome.kind === "exact" ? combinedOutcome.transitionStatus : null,
	"combined",
	"Auto/direct orchestration preserves combined semantics",
);

const reordered = contentResemblance("alpha beta gamma delta", "gamma delta alpha beta");
const preserved = contentResemblance("alpha beta gamma delta", "alpha beta gamma changed");
assert.ok(
	preserved.orderedTokens > reordered.orderedTokens,
	"ordered token shingles distinguish a local edit from reordered content",
);
const repeated = contentResemblance("alpha alpha alpha beta", "alpha beta beta beta");
assert.ok(repeated.tokenFrequency < 1, "token-frequency resemblance retains repeated-token information");
const splitTransition = buildScopeTransition(combined, separate);
const splitRelations = [...splitTransition.splitTo.values()];
assert.equal(splitRelations.length, 2);
assert.ok(splitRelations.every((relation) => relation.from.key === "section:0"));
const splitOutcome = resolveSelectedTransition(
	splitTransition,
	separate.scopes.find((scope) => scope.kind === "section")!,
);
assert.equal(splitOutcome.kind, "exact");
assert.equal(
	splitOutcome.kind === "exact" ? splitOutcome.transitionStatus : null,
	"split",
	"Auto/direct orchestration preserves split semantics",
);

// A nested 3x3-style grid maps stable cells while reporting a new nested cell.
const gridBase = index([
	container(
		"grid",
		"{cols=3}",
		Array.from({ length: 9 }, (_, at) =>
			cell(
				at === 4
					? [container("tabs", "", [tab("Nested", `cell ${at}\n`)])]
					: at === 8
						? [container("grid", "{cols=1}", [cell("nested grid\n")])]
						: `cell ${at}\n`,
			),
		),
	),
]);
const gridNext = index([
	container("grid", "{cols=3}", [
		...Array.from({ length: 9 }, (_, at) =>
			cell(
				at === 4
					? [container("tabs", "", [tab("Nested", `cell ${at} edited\n`)])]
					: at === 8
						? [container("grid", "{cols=1}", [cell("nested grid\n"), cell("new nested cell\n")])]
						: `cell ${at}\n`,
			),
		),
	]),
]);
const gridTransition = buildScopeTransition(gridBase, gridNext);
const newNestedCell = gridNext.scopes.find((scope) => scope.kind === "cell" && scope.path.join(".") === "0.8.0.1");
assert.ok(newNestedCell);
assert.ok(gridTransition.added.has(newNestedCell.key));

// A heterogeneous 3×3 grid proves Added/Removed classification for every
// inspectable inner scope kind, including grids inside tabs and tabs inside
// cells. The hidden fixture structure is never serialized as identity.
const heterogeneous = index([
	container("grid", "{cols=3}", [
		cell("plain text\n"),
		cell("> [!note] Callout\n> body\n"),
		cell("```ts\nconst answer = 42;\n```\n"),
		cell([container("tabs", "", [tab("Nested tab", "tab body\n")])]),
		cell([container("grid", "{cols=1}", [cell("nested grid body\n")])]),
		cell([container("section", "", [leaf("combined\n\nsection\n")])]),
		cell("# Markdown heading\n"),
		cell("> [!tip] Nested kind\n> ```js\n> ok()\n> ```\n"),
		cell([container("tabs", "", [tab("Grid tab", [container("grid", "{cols=1}", [cell("deep nested\n")])])])]),
	]),
]);
const empty = index([]);
const allKinds = new Set(heterogeneous.scopes.filter((scope) => scope.kind !== "block").map((scope) => scope.kind));
assert.deepEqual(
	allKinds,
	new Set(["grid", "cell", "section", "callout", "code", "tabs", "tab"]),
	"the fixed fixture exercises every supported inner scope kind",
);
const allAdded = buildScopeTransition(empty, heterogeneous);
const allRemoved = buildScopeTransition(heterogeneous, empty);
for (const scope of heterogeneous.scopes.filter((candidate) => candidate.kind !== "block")) {
	assert.ok(allAdded.added.has(scope.key), `${scope.kind} ${scope.key} should be Added`);
	assert.ok(allRemoved.removed.has(scope.key), `${scope.kind} ${scope.key} should be Removed`);
}

const deep = (body: string, depth: number): MicaNode[] => {
	let children: MicaNode[] = [leaf(body)];
	for (let level = depth; level > 0; level--) {
		children =
			level % 2
				? [container("tabs", "", [tab(`Depth ${level}`, children)])]
				: [container("grid", "{cols=1}", [cell(children)])];
	}
	return children;
};
const deepBase = index(deep("deep stable body\n", 7));
const deepEdited = index(deep("deep stable body edited\n", 7));
const deepTransition = buildScopeTransition(deepBase, deepEdited);
const deepest = deepEdited.scopes.find((scope) => scope.kind === "section");
assert.ok(deepest);
assert.equal(deepTransition.reverse.get(deepest.key)?.status, "changed", "parent propagation is depth-independent");
assert.equal(deepTransition.added.has(deepest.key), false);

// Identical duplicates remain unresolved rather than being paired by ordinal.
const duplicateBase = index([leaf("same\n\n"), leaf("same\n")]);
const duplicateNext = index([leaf("same\n\n"), leaf("same\n\n"), leaf("same\n")]);
const duplicates = buildScopeTransition(duplicateBase, duplicateNext);
assert.equal(
	[...duplicates.reverse.values()].filter((match) => match.to.kind === "section").length,
	1,
	"only the uniquely fingerprinted trailing section is paired",
);
assert.ok(duplicates.ambiguousTo.size > 0);

// Ambiguous duplicate buckets stay explicit but never retain more candidates
// than the inspector can materialize.
const manyDuplicates = index(Array.from({ length: 80 }, () => leaf("same duplicate\n\n")));
const moreDuplicates = index(Array.from({ length: 81 }, () => leaf("same duplicate\n\n")));
const boundedDuplicates = buildScopeTransition(manyDuplicates, moreDuplicates);
for (const candidates of boundedDuplicates.ambiguousTo.values()) assert.ok(candidates.length <= 64);
for (const candidates of boundedDuplicates.ambiguousFrom.values()) assert.ok(candidates.length <= 64);

console.log("VERSION TRANSITION OK");
