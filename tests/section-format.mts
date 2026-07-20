import assert from "node:assert/strict";
import { buildCallout, parseCallout } from "../src/ui/calloutFence.ts";
import { classifySection, convertSection } from "../src/ui/sectionFormat.ts";

const exactLf = [
	"",
	" \t",
	"  >[!TIP]-   Exact title  ",
	"  > Body with two spaces  ",
	"  >> [!note] Nested",
	"\t",
	"",
].join("\n");
const parsedLf = parseCallout(exactLf);
assert.ok(parsedLf);
assert.equal(parsedLf.prefix, "\n \t\n");
assert.equal(parsedLf.indent, "  ");
assert.equal(parsedLf.markerGap, "");
assert.equal(parsedLf.type, "TIP");
assert.equal(parsedLf.fold, "-");
assert.equal(parsedLf.titleRaw, "   Exact title  ");
assert.equal(parsedLf.title, "Exact title");
assert.equal(parsedLf.headerEol, "\n");
assert.equal(parsedLf.body, "Body with two spaces  \n> [!note] Nested");
assert.equal(parsedLf.bodyEndEol, "\n");
assert.equal(parsedLf.bodySource, "Body with two spaces  \n> [!note] Nested\n");
assert.equal(parsedLf.suffix, "\t\n");
assert.equal(buildCallout(parsedLf), exactLf, "an untouched LF callout must be byte-exact");
assert.equal(
	buildCallout(parsedLf, {
		type: parsedLf.type,
		fold: parsedLf.fold,
		title: parsedLf.title,
		body: parsedLf.body,
	}),
	exactLf,
	"explicitly unchanged fields must retain the exact source",
);

const exactCrlf = "\r\n   > \t[!note]+\t CRLF title\t\r\n   > first\r\n   >\r\n   > third\r\n \t\r\n";
const parsedCrlf = parseCallout(exactCrlf);
assert.ok(parsedCrlf);
assert.equal(parsedCrlf.prefix, "\r\n");
assert.equal(parsedCrlf.indent, "   ");
assert.equal(parsedCrlf.markerGap, " \t");
assert.equal(parsedCrlf.title, "CRLF title");
assert.equal(parsedCrlf.body, "first\r\n\r\nthird");
assert.equal(parsedCrlf.bodyEndEol, "\r\n");
assert.equal(parsedCrlf.bodySource, "first\r\n\r\nthird\r\n");
assert.equal(parsedCrlf.suffix, " \t\r\n");
assert.equal(buildCallout(parsedCrlf), exactCrlf, "an untouched CRLF callout must be byte-exact");
assert.equal(
	buildCallout(parsedCrlf, {
		type: "warning",
		fold: "-",
		title: "Changed",
		body: "alpha\r\n\r\nbeta",
	}),
	"\r\n   > \t[!warning]- Changed\r\n   > alpha\r\n   >\r\n   > beta\r\n \t\r\n",
	"a structured edit keeps indentation, marker spacing, CRLF, and boundary whitespace",
);

assert.equal(parseCallout("> [!note] Fine\n> body\nnot boundary whitespace\n"), null);
assert.equal(parseCallout("    > [!note] too deeply indented\n"), null);
assert.throws(() => buildCallout(parsedLf, { type: "bad type" }), /callout type/i);
assert.throws(() => buildCallout(parsedLf, { title: "bad\ntitle" }), /callout title/i);

assert.equal(classifySection("plain **Markdown**\n"), "markdown");
assert.equal(classifySection(exactLf), "callout");
assert.equal(classifySection("\n```custom-processor\nbody\n```\n\t"), "code");
assert.equal(classifySection("```custom-processor\nunterminated\n"), "markdown");

for (const source of ["alpha", "alpha\n", "\r\nalpha\r\n\r\n", " \t\r\nalpha  \r\n \t", "", "\n"]) {
	const asCallout = convertSection(source, "callout");
	assert.equal(asCallout.from, "markdown");
	assert.equal(asCallout.to, "callout");
	assert.equal(asCallout.warnings.length, 0);
	assert.equal(classifySection(asCallout.text), "callout");
	assert.equal(convertSection(asCallout.text, "markdown").text, source, "callout conversion must round-trip");

	const asCode = convertSection(source, "code");
	assert.equal(asCode.warnings.length, 0);
	assert.equal(classifySection(asCode.text), "code");
	assert.equal(convertSection(asCode.text, "markdown").text, source, "code conversion must round-trip");
}

const sameMarkdown = "plain\r\n";
assert.deepEqual(convertSection(sameMarkdown, "markdown"), {
	from: "markdown",
	to: "markdown",
	text: sameMarkdown,
	warnings: [],
});
assert.deepEqual(convertSection(exactLf, "callout"), {
	from: "callout",
	to: "callout",
	text: exactLf,
	warnings: [],
});

const unwrappedCallout = convertSection(exactLf, "markdown");
assert.equal(unwrappedCallout.text, "\n \t\nBody with two spaces  \n> [!note] Nested\n\t\n");
assert.deepEqual(
	unwrappedCallout.warnings.map((warning) => warning.name),
	["callout-metadata-loss"],
);
assert.equal(unwrappedCallout.warnings[0]?.metadata.type, "TIP");
assert.equal(unwrappedCallout.warnings[0]?.metadata.fold, "-");
assert.equal(unwrappedCallout.warnings[0]?.metadata.title, "Exact title");

const unknownCode = "\r\n~~~~ custom-processor arg=1\r\nbody\r\n~~~~\r\n\t";
assert.deepEqual(convertSection(unknownCode, "code"), {
	from: "code",
	to: "code",
	text: unknownCode,
	warnings: [],
});
const unwrappedCode = convertSection(unknownCode, "markdown");
assert.equal(unwrappedCode.text, "\r\nbody\r\n\t");
assert.deepEqual(
	unwrappedCode.warnings.map((warning) => warning.name),
	["code-info-loss"],
);
assert.equal(unwrappedCode.warnings[0]?.metadata.info, "custom-processor arg=1");

const calloutToCode = convertSection("> [!warning]+ Heads up\n> ```js\n> inner\n> ```\n", "code");
assert.equal(classifySection(calloutToCode.text), "code");
assert.deepEqual(
	calloutToCode.warnings.map((warning) => warning.name),
	["callout-metadata-loss"],
);
assert.equal(convertSection(calloutToCode.text, "markdown").text, "```js\ninner\n```\n");

const codeToCallout = convertSection("```made-up\nalpha\n```\n", "callout");
assert.equal(classifySection(codeToCallout.text), "callout");
assert.deepEqual(
	codeToCallout.warnings.map((warning) => warning.name),
	["code-info-loss"],
);
assert.equal(convertSection(codeToCallout.text, "markdown").text, "alpha\n");

const nestedFence = convertSection("before\n```js\ninner\n```\nafter", "code");
assert.match(nestedFence.text, /^````\n/u, "wrapping grows beyond an inner backtick fence");
assert.equal(convertSection(nestedFence.text, "markdown").text, "before\n```js\ninner\n```\nafter");

console.log("SECTION FORMAT OK");
