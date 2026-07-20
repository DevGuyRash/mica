import assert from "node:assert/strict";
import {
	interactiveDiffIssue,
	MAX_INTERACTIVE_CHAR_DIFF_CODE_UNITS,
	MAX_INTERACTIVE_DIFF_CODE_UNITS,
	MAX_INTERACTIVE_DIFF_LINE_CODE_UNITS,
	MAX_INTERACTIVE_DIFF_LINES,
	MAX_INTERACTIVE_WORD_DIFF_CODE_UNITS,
} from "../src/diff/budget.ts";

assert.equal(interactiveDiffIssue("a\n", "b\n", "line"), null);
assert.match(
	interactiveDiffIssue("a".repeat(MAX_INTERACTIVE_DIFF_CODE_UNITS), "b", "line") ?? "",
	/comparison exceeds/,
);
assert.match(
	interactiveDiffIssue("a".repeat(MAX_INTERACTIVE_CHAR_DIFF_CODE_UNITS), "b", "char") ?? "",
	/character diff exceeds/,
);
assert.match(
	interactiveDiffIssue("a".repeat(MAX_INTERACTIVE_WORD_DIFF_CODE_UNITS), "b", "word") ?? "",
	/word diff exceeds/,
);
assert.match(
	interactiveDiffIssue("a".repeat(MAX_INTERACTIVE_DIFF_LINE_CODE_UNITS + 1), "b", "line-char") ?? "",
	/a line exceeds/,
);
assert.match(
	interactiveDiffIssue(`${"x\n".repeat(MAX_INTERACTIVE_DIFF_LINES)}x`, "b", "line") ?? "",
	/line interactive limit/,
);

console.log("DIFF BUDGET OK");
