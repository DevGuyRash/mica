import assert from "node:assert/strict";
import {
	dedentNested,
	findNestedCallouts,
	findNestedCodeBlocks,
	findNestedSections,
	materializeQuotedSection,
	requoteAtDepth,
	requoteOnce,
	spliceLines,
	spliceQuotedSection,
} from "../src/ui/nestedCallouts.ts";

const fencedFakeCallout = [
	"> [!note] Outer",
	"> before",
	"> ```md",
	"> > [!danger] This is code, not a callout",
	"> ```",
	"> > [!tip] Real nested callout",
	"> > body",
].join("\n");

assert.deepEqual(findNestedCallouts(fencedFakeCallout), [{ startLine: 5, endLine: 7, depth: 2 }]);
assert.deepEqual(findNestedCodeBlocks(fencedFakeCallout), [
	{
		startLine: 2,
		endLine: 5,
		depth: 1,
		fenceChar: "`",
		fenceLength: 3,
		info: "md",
		closed: true,
	},
]);

const mixed = [
	"```txt",
	"> [!fake] An unquoted fence is not a nested section",
	"```",
	"> [!note] Outer",
	"> > [!example] Inner",
	"> > ~~~~c++ extra",
	"> > int main() {}",
	"> > ~~~~",
	"> > tail",
	"> after",
].join("\n");
const projected = findNestedSections(mixed);
assert.deepEqual(projected.callouts, [{ startLine: 4, endLine: 9, depth: 2 }]);
assert.deepEqual(projected.codeBlocks, [
	{
		startLine: 5,
		endLine: 8,
		depth: 2,
		fenceChar: "~",
		fenceLength: 4,
		info: "c++ extra",
		closed: true,
	},
]);

const quotedCrLf =
	"> [!note] Outer\r\n" +
	"> before\r\n" +
	"> > ~~~~md\r\n" +
	"> > # heading\r\n" +
	"> > > literal quote\r\n" +
	"> > ~~~~\r\n" +
	"> after\r\n";
const [quotedCode] = findNestedCodeBlocks(quotedCrLf);
assert.ok(quotedCode);
assert.deepEqual(quotedCode, {
	startLine: 2,
	endLine: 6,
	depth: 2,
	fenceChar: "~",
	fenceLength: 4,
	info: "md",
	closed: true,
});

const materializedCode = "~~~~md\r\n# heading\r\n> literal quote\r\n~~~~";
assert.equal(materializeQuotedSection(quotedCrLf, quotedCode), materializedCode);
assert.equal(requoteAtDepth(materializedCode, 2), quotedCrLf.split("\r\n").slice(2, 6).join("\r\n"));
assert.equal(
	spliceQuotedSection(quotedCrLf, quotedCode, materializedCode),
	quotedCrLf,
	"materializing and splicing an untouched canonical quoted fence is byte-exact",
);

const replacement = "```ts\r\nconst value = 1;\r\n```";
assert.equal(
	spliceQuotedSection(quotedCrLf, quotedCode, replacement),
	"> [!note] Outer\r\n> before\r\n> > ```ts\r\n> > const value = 1;\r\n> > ```\r\n> after\r\n",
);
assert.equal(spliceQuotedSection(quotedCrLf, quotedCode, null), "> [!note] Outer\r\n> before\r\n> after\r\n");

const deepCallout = ["> [!note] Outer", "> > [!tip] Middle", "> > > [!warning] Deep", "> > > body"].join("\n");
const deep = findNestedCallouts(deepCallout)[1];
assert.ok(deep);
assert.equal(materializeQuotedSection(deepCallout, deep, 1), "> [!warning] Deep\n> body");
assert.equal(
	spliceQuotedSection(deepCallout, deep, "> [!warning] Changed\n> body", 1),
	"> [!note] Outer\n> > [!tip] Middle\n> > > [!warning] Changed\n> > > body",
);

// Compatibility pins for the existing line helpers and their one-level callout lift.
assert.equal(dedentNested(deepCallout, deep), "> > [!warning] Deep\n> > body");
assert.equal(requoteOnce("alpha\n\nbeta"), "> alpha\n>\n> beta");
assert.equal(spliceLines("a\nb\nc", 1, 2, "x\ny"), "a\nx\ny\nc");

const unclosed = "> [!note]\n> ```js\n> const value = 1;";
assert.deepEqual(findNestedCodeBlocks(unclosed), [
	{
		startLine: 1,
		endLine: 3,
		depth: 1,
		fenceChar: "`",
		fenceLength: 3,
		info: "js",
		closed: false,
	},
]);

assert.equal(findNestedCodeBlocks("> [!note]\n> ```\n> value\n> ```")[0]?.info, "");
assert.throws(() => materializeQuotedSection("text", { startLine: -1, endLine: 1, depth: 1 }), /line range/);
assert.throws(() => requoteAtDepth("text", -1), /quote depth/);

console.log("NESTED SECTIONS OK");
