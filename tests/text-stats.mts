import assert from "node:assert/strict";
import { textStats } from "../src/ui/textStats.ts";

assert.deepEqual(textStats("A callout with **bold** text.\n\n\n"), {
	words: 5,
	characters: 29,
	lines: 3,
	sourceUnits: 32,
	utf8Bytes: 32,
	rawLines: 4,
	lineEndings: 3,
});

const unicode = textStats("e\u0301 👨‍👩‍👧‍👦 😀\r\n\r\nlast\r\n");
assert.equal(unicode.characters, 9, "graphemes, spaces, and visible text count; CR/LF do not");
assert.equal(unicode.lines, 3, "an intentional blank line counts, but a terminal EOL adds no phantom line");
assert.equal(unicode.rawLines, 4);
assert.equal(unicode.lineEndings, 3);
assert.ok(unicode.utf8Bytes > unicode.sourceUnits);

assert.deepEqual(textStats(""), {
	words: 0,
	characters: 0,
	lines: 0,
	sourceUnits: 0,
	utf8Bytes: 0,
	rawLines: 0,
	lineEndings: 0,
});

console.log("TEXT STATS OK");
