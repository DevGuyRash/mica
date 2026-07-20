import assert from "node:assert/strict";
import { buildCodeFence, isCodeFence, parseCodeFence } from "../src/ui/codeFence.ts";

const lf = ["", " \t", "  ````markdown meta=1", "line one", "```js", "inner", "```", "  ````  ", "\t", ""].join("\n");
const parsedLf = parseCodeFence(lf);
assert.ok(parsedLf);
assert.equal(parsedLf.prefix, "\n \t\n");
assert.equal(parsedLf.indent, "  ");
assert.equal(parsedLf.fenceChar, "`");
assert.equal(parsedLf.openLen, 4);
assert.equal(parsedLf.infoRaw, "markdown meta=1");
assert.equal(parsedLf.language, "markdown");
assert.equal(parsedLf.openEol, "\n");
assert.equal(parsedLf.body, "line one\n```js\ninner\n```\n");
assert.equal(parsedLf.closeIndent, "  ");
assert.equal(parsedLf.closeLen, 4);
assert.equal(parsedLf.closeTrailing, "  ");
assert.equal(parsedLf.closeEol, "\n");
assert.equal(parsedLf.suffix, "\t\n");
assert.equal(buildCodeFence(parsedLf), lf, "an untouched LF fence must be byte-exact");
assert.equal(buildCodeFence(parsedLf, { infoRaw: parsedLf.infoRaw, body: parsedLf.body }), lf);

const crlf = "\r\n~~~  md extra\r\nalpha\r\n~~~~\r\n \t\r\n";
const parsedCrlf = parseCodeFence(crlf);
assert.ok(parsedCrlf);
assert.equal(parsedCrlf.prefix, "\r\n");
assert.equal(parsedCrlf.infoRaw, "  md extra");
assert.equal(parsedCrlf.language, "md");
assert.equal(parsedCrlf.openEol, "\r\n");
assert.equal(parsedCrlf.body, "alpha\r\n");
assert.equal(parsedCrlf.closeLen, 4);
assert.equal(parsedCrlf.closeEol, "\r\n");
assert.equal(parsedCrlf.suffix, " \t\r\n");
assert.equal(buildCodeFence(parsedCrlf), crlf, "an untouched CRLF fence must be byte-exact");

const empty = parseCodeFence("```\n```\n");
assert.ok(empty);
assert.equal(empty.infoRaw, "");
assert.equal(empty.language, "");
assert.equal(empty.body, "");
assert.equal(buildCodeFence(empty), "```\n```\n");

const grow = parseCodeFence(" ````js\nold\n  ````` \n\t");
assert.ok(grow);
assert.equal(
	buildCodeFence(grow, {
		infoRaw: "typescript meta=kept",
		body: "const x = 1;\n  `````nested\n",
	}),
	" ``````typescript meta=kept\nconst x = 1;\n  `````nested\n  `````` \n\t",
	"editing grows both fence runs above a conflicting body run",
);

const noShrink = parseCodeFence("``````rust\nfn main() {}\n```````\n");
assert.ok(noShrink);
assert.equal(
	buildCodeFence(noShrink, { infoRaw: "rs", body: "fn changed() {}\n" }),
	"``````rs\nfn changed() {}\n```````\n",
	"editing never shrinks either existing fence run",
);

const tildeInfo = parseCodeFence("~~~lang`variant\nbody\n~~~");
assert.ok(tildeInfo, "tilde info strings may contain backticks");
assert.equal(tildeInfo.language, "lang`variant");

for (const source of [
	"text\n```js\nx\n```\n",
	"```js\nx\n```\ntext\n",
	"    ```js\nx\n    ```\n",
	"```bad`info\nx\n```\n",
	"```js\nx\n",
	"```js\nx\n~~~\n",
	"````js\nx\n```\n",
]) {
	assert.equal(parseCodeFence(source), null, `invalid region was classified as code: ${JSON.stringify(source)}`);
	assert.equal(isCodeFence(source), false);
}
assert.equal(isCodeFence(lf), true);
assert.equal(isCodeFence(crlf), true);

assert.throws(() => buildCodeFence(parsedLf, { infoRaw: "bad`info" }), /info string/i);
assert.throws(() => buildCodeFence(parsedLf, { infoRaw: "js\ntext" }), /info string/i);

console.log("CODE FENCE OK");
