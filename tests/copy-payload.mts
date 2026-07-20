import assert from "node:assert/strict";
import { copyNodes, copyText } from "../src/ui/copyPayload.ts";
import type { MicaNode } from "../src/wasm/bridge.ts";

const leaf = (text: string): MicaNode => ({ kind: "leaf", text, is_code: false });
const cell = (text: string): MicaNode => ({
	kind: "container",
	name: "cell",
	title: "",
	colons: 3,
	open_line: ":::cell\r\n",
	children: [leaf(text)],
	close_line: ":::\r\n",
});
const grid: MicaNode = {
	kind: "container",
	name: "grid",
	title: "{cols=2}",
	colons: 3,
	open_line: ":::grid {cols=2}\r\n",
	children: [cell("  alpha  \r\n\r\n"), cell("> [!note] Keep\r\n> body\r\n")],
	close_line: ":::\r\n",
};

const plain = "  alpha  \r\n\r\n> [!note] Keep\r\n> body\r\n";
const syntax =
	":::grid {cols=2}\r\n:::cell\r\n  alpha  \r\n\r\n:::\r\n:::cell\r\n> [!note] Keep\r\n> body\r\n:::\r\n:::\r\n";

assert.equal(copyNodes([grid], { includeMicaSyntax: false, includeOuterContainer: false }), plain);
assert.equal(copyNodes([grid], { includeMicaSyntax: true, includeOuterContainer: false }), syntax);
assert.equal(
	copyNodes([grid], { includeMicaSyntax: false, includeOuterContainer: true }),
	`\`\`\`mica\n${plain}\`\`\``,
);
assert.equal(
	copyNodes([grid], { includeMicaSyntax: true, includeOuterContainer: true }),
	`\`\`\`mica\n${syntax}\`\`\``,
);

const code = "before\n```js\nconst x = 1;\n```\nafter";
assert.equal(
	copyText(code, { includeMicaSyntax: true, includeOuterContainer: true }),
	"````mica\nbefore\n```js\nconst x = 1;\n```\nafter\n````",
);
assert.equal(
	copyText("exact \t bytes\r\n", { includeMicaSyntax: false, includeOuterContainer: false }),
	"exact \t bytes\r\n",
);
assert.equal(copyText("", { includeMicaSyntax: false, includeOuterContainer: true }), "```mica\n```");

const friendlyTabs: MicaNode[] = [
	{
		kind: "container",
		name: "tabs",
		title: "",
		colons: 0,
		open_line: "",
		children: [
			{
				kind: "container",
				name: "tab",
				title: "Empty",
				colons: 0,
				open_line: "tab: Empty\n",
				children: [leaf("")],
				close_line: "",
			},
			{
				kind: "container",
				name: "tab",
				title: "Notes",
				colons: 0,
				open_line: "tab: Notes\n",
				children: [leaf("\n\tindented\n\n\n")],
				close_line: "",
			},
		],
		close_line: "",
	},
];
assert.equal(copyNodes(friendlyTabs, { includeMicaSyntax: false, includeOuterContainer: false }), "\tindented\n");
assert.equal(
	copyNodes(friendlyTabs, { includeMicaSyntax: true, includeOuterContainer: false }),
	"tab: Empty\ntab: Notes\n\n\tindented\n\n\n",
);

let deep: MicaNode = leaf("deep\n");
for (let depth = 0; depth < 128; depth++) {
	deep = {
		kind: "container",
		name: depth % 2 ? "cell" : "tab",
		title: "",
		colons: 3,
		open_line: ":::cell\n",
		children: [deep],
		close_line: ":::\n",
	};
}
assert.equal(copyNodes([deep], { includeMicaSyntax: false, includeOuterContainer: false }), "deep\n");

console.log("COPY PAYLOAD OK");
