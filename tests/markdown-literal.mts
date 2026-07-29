import assert from "node:assert/strict";
import { protectLiteralAnglePlaceholders } from "../src/ui/markdownLiteral";

assert.equal(
	protectLiteralAnglePlaceholders("WHEN <condition> THEN <action>\n"),
	"WHEN &lt;condition&gt; THEN &lt;action&gt;\n",
);
assert.equal(
	protectLiteralAnglePlaceholders("<strong>real HTML</strong> <https://example.com>"),
	"<strong>real HTML</strong> <https://example.com>",
);
assert.equal(protectLiteralAnglePlaceholders("`<condition>` and <result>"), "`<condition>` and &lt;result&gt;");
assert.equal(
	protectLiteralAnglePlaceholders("```html\n<condition>\n```\nAfter <condition>\n"),
	"```html\n<condition>\n```\nAfter &lt;condition&gt;\n",
);
assert.equal(
	protectLiteralAnglePlaceholders("~~~\r\n<condition>\r\n~~~\r\n<result>\r\n"),
	"~~~\r\n<condition>\r\n~~~\r\n&lt;result&gt;\r\n",
);
assert.equal(
	protectLiteralAnglePlaceholders(
		"> ```text\n> <condition>\n> ```\n> Quoted prose <condition>\n\n>   ~~~\n> <result>\n>   ~~~\n",
	),
	"> ```text\n> <condition>\n> ```\n> Quoted prose &lt;condition&gt;\n\n>   ~~~\n> <result>\n>   ~~~\n",
);
assert.equal(
	protectLiteralAnglePlaceholders(">     <condition>\r\n> \t<result>\r\n> Ordinary <condition>\r\n"),
	">     <condition>\r\n> \t<result>\r\n> Ordinary &lt;condition&gt;\r\n",
);
assert.equal(
	protectLiteralAnglePlaceholders("    <condition>\n\t<result>\n\nAfter code <condition>\n"),
	"    <condition>\n\t<result>\n\nAfter code &lt;condition&gt;\n",
);
assert.equal(
	protectLiteralAnglePlaceholders("> Ordinary <condition>\nAfter quote <result>\n"),
	"> Ordinary &lt;condition&gt;\nAfter quote &lt;result&gt;\n",
);

console.log("MARKDOWN LITERAL PLACEHOLDERS OK");
