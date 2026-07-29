import assert from "node:assert/strict";
import type { Cst, MicaNode } from "../src/wasm/bridge.ts";
import { stripStructuralLines } from "../src/diff/hideSyntax.ts";

const leaf = (text: string): MicaNode => ({ kind: "leaf", text, is_code: false });
const container = (
	name: string,
	title: string,
	open_line: string,
	children: MicaNode[],
	close_line = ":::\n",
): MicaNode => ({ kind: "container", name, title, colons: 3, open_line, children, close_line });
const cst = (children: MicaNode[]): Cst => ({ children });

/** What the previous line-prefix filter did, kept here so the difference between
 * the two is asserted rather than described. */
const byLinePrefix = (source: string): string =>
	source
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			return !trimmed.startsWith(":::") && !/^tab:(\s|$)/.test(trimmed);
		})
		.join("\n");

// --- scaffolding goes, content stays ----------------------------------------

const tabs = cst([
	container("tabs", "", ":::tabs\n", [
		container("tab", "One", ":::tab One\n", [leaf("first body\n")]),
		container("tab", "Two", ":::tab Two\n", [leaf("second body\n")]),
	]),
]);
assert.equal(
	stripStructuralLines(tabs),
	"first body\nsecond body\n",
	"container opening and closing lines are removed, their content is not",
);

const nested = cst([
	container("grid", "{cols=2}", ":::grid {cols=2}\n", [
		container("cell", "", ":::cell\n", [leaf("alpha\n")]),
		container("cell", "", ":::cell\n", [leaf("beta\n")]),
	]),
]);
assert.equal(stripStructuralLines(nested), "alpha\nbeta\n", "nesting is unwound to its leaves");

assert.equal(stripStructuralLines(cst([leaf("plain\n")])), "plain\n", "a block with no containers is unchanged");
assert.equal(stripStructuralLines(cst([])), "", "an empty block yields nothing");

// --- the case the line-prefix filter got wrong ------------------------------

// A fenced code block whose body happens to contain Mica's own directive
// syntax. The old filter deleted those lines, so a change to them vanished from
// the diff entirely — silently dropping a real edit is worse than showing
// scaffolding.
const literal = ":::tabs\nnot really a container\n:::\n";
const codeBlock = cst([container("tab", "Doc", ":::tab Doc\n", [leaf("```md\n" + literal + "```\n")])]);
assert.equal(
	stripStructuralLines(codeBlock),
	"```md\n:::tabs\nnot really a container\n:::\n```\n",
	"authored content that looks like syntax survives, because the CST says it is a leaf",
);
assert.ok(
	!byLinePrefix("```md\n" + literal + "```\n").includes(":::tabs"),
	"the previous filter really did delete it — this is the regression being fixed",
);

// A prose line beginning with `tab:` is content, not the friendly tab syntax.
const prose = cst([leaf("tab: separated values are fine\n")]);
assert.equal(stripStructuralLines(prose), "tab: separated values are fine\n", "a leaf starting with `tab:` is kept");
assert.equal(byLinePrefix("tab: separated values are fine\n"), "", "the previous filter dropped it entirely");

// --- malformed historical content is left exactly as authored ---------------

// Closers once serialized glued onto a leaf ("a:::"). The parser sees leaf text,
// so it stays: inventing structure to hide it would be a second guess stacked on
// the first, and it is genuinely part of what the user's snapshot contains.
const malformed = cst([container("cell", "", ":::cell\n", [leaf("a:::\n")], "")]);
assert.equal(
	stripStructuralLines(malformed),
	"a:::\n",
	"a glued closer is leaf text and is reported, not silently reshaped",
);

console.log("hide-syntax: ok");
