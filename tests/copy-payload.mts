import assert from "node:assert/strict";
import {
	clipboardText,
	copyNodes,
	copyOptionsFromSettings,
	copyText,
	DEFAULT_COPY_OPTIONS,
} from "../src/ui/copyPayload.ts";
import { resolveExactCopySelection } from "../src/ui/copySelection.ts";
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

assert.deepEqual(
	copyOptionsFromSettings({
		copyIncludeMicaSyntax: true,
		copyIncludeOuterContainer: false,
		copyIncludeLineNumbers: true,
		copyLineNumberScope: "output",
	}),
	{
		includeMicaSyntax: true,
		includeOuterContainer: false,
		includeLineNumbers: true,
		lineNumberScope: "output",
	},
);
assert.equal(
	clipboardText({ nodes: [grid] }, DEFAULT_COPY_OPTIONS),
	plain,
	"all copy surfaces should share the default structural projection",
);

assert.equal(copyNodes([grid], { includeMicaSyntax: false, includeOuterContainer: false }), plain);
assert.equal(copyNodes([grid], { includeMicaSyntax: true, includeOuterContainer: false }), syntax);
assert.equal(
	copyNodes([grid], { includeMicaSyntax: false, includeOuterContainer: true }),
	`\`\`\`mica\r\n${plain}\`\`\``,
);
assert.equal(
	copyNodes([grid], { includeMicaSyntax: true, includeOuterContainer: true }),
	`\`\`\`mica\r\n${syntax}\`\`\``,
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

const splitBoundaries: MicaNode = {
	kind: "container",
	name: "section",
	title: "",
	colons: 3,
	open_line: ":::section``",
	children: [leaf("``body\r")],
	close_line: "\n:::",
};
assert.equal(
	copyNodes([splitBoundaries], {
		includeMicaSyntax: true,
		includeOuterContainer: true,
	}),
	"`````mica\r\n:::section````body\r\n:::\r\n`````",
	"fence and CRLF detection crosses structural segment boundaries without flattening source",
);

assert.equal(
	copyText("alpha\n\nbeta\n", {
		includeMicaSyntax: false,
		includeOuterContainer: false,
		includeLineNumbers: true,
		lineNumberScope: "content",
	}),
	"1 │ alpha\n2 │ \n3 │ beta\n",
);
assert.equal(
	copyNodes([grid], {
		includeMicaSyntax: true,
		includeOuterContainer: true,
		includeLineNumbers: true,
		lineNumberScope: "content",
	}),
	"```mica\r\n:::grid {cols=2}\r\n:::cell\r\n1 │   alpha  \r\n2 │ \r\n:::\r\n:::cell\r\n3 │ > [!note] Keep\r\n4 │ > body\r\n:::\r\n:::\r\n```",
);
assert.equal(
	copyText("one\r\ntwo", {
		includeMicaSyntax: false,
		includeOuterContainer: true,
		includeLineNumbers: true,
		lineNumberScope: "output",
	}),
	"1 │ ```mica\r\n2 │ one\r\n3 │ two\r\n4 │ ```",
);
assert.equal(
	copyText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), {
		includeMicaSyntax: false,
		includeOuterContainer: false,
		includeLineNumbers: true,
		lineNumberScope: "content",
	}),
	Array.from({ length: 10 }, (_, index) => `${String(index + 1).padStart(2)} │ line ${index + 1}`).join("\n"),
);

// Every preference remains orthogonal. Exercise the complete 2×2×2×2
// matrix rather than letting a later serializer accidentally make one toggle
// imply another. Content numbering counts only authored leaves; output
// numbering counts the fully serialized projection.
const matrix = new Map<string, string>();
for (const includeMicaSyntax of [false, true]) {
	for (const includeOuterContainer of [false, true]) {
		for (const includeLineNumbers of [false, true]) {
			for (const lineNumberScope of ["content", "output"] as const) {
				const key = JSON.stringify({
					includeMicaSyntax,
					includeOuterContainer,
					includeLineNumbers,
					lineNumberScope,
				});
				const value = copyNodes([grid], {
					includeMicaSyntax,
					includeOuterContainer,
					includeLineNumbers,
					lineNumberScope,
				});
				matrix.set(key, value);
				assert.equal(/(^|[^\r])\n/.test(value), false, `matrix case ${key} introduced a bare LF`);
				if (!includeLineNumbers) {
					const counterpart = matrix.get(
						JSON.stringify({
							includeMicaSyntax,
							includeOuterContainer,
							includeLineNumbers,
							lineNumberScope: "content",
						}),
					);
					if (counterpart) assert.equal(value, counterpart, "numbering scope leaked while numbering was off");
				} else if (lineNumberScope === "content") {
					const prefixes = [...value.matchAll(/(?:^|\r\n)\s*(\d+) │ /g)].map((match) => Number(match[1]));
					assert.deepEqual(prefixes, [1, 2, 3, 4], `content numbering drifted for ${key}`);
					if (includeOuterContainer)
						assert.match(value, /^```mica\r\n/, "outer fence was numbered as content");
					if (includeMicaSyntax) assert.match(value, /(?:^|\r\n):::grid /, "Mica directives disappeared");
				} else {
					const splitLines = value.split("\r\n");
					const lines = value.endsWith("\r\n") ? splitLines.slice(0, -1) : splitLines;
					for (let index = 0; index < lines.length; index++) {
						assert.match(
							lines[index],
							new RegExp(`^\\s*${index + 1} │ `),
							`output line ${index + 1} was not numbered for ${key}`,
						);
					}
				}
			}
		}
	}
}
assert.equal(matrix.size, 16);

// A section action passes exactly this node, never its owning tab/grid. Prove
// every clipboard projection excludes both siblings and all ancestor syntax.
const exactSection: MicaNode = {
	kind: "container",
	name: "section",
	title: "",
	colons: 3,
	open_line: ":::section\r\n",
	children: [leaf("  selected\r\n\r\n"), cell("nested\r\n")],
	close_line: ":::\r\n",
};
const sectionPlain = "  selected\r\n\r\nnested\r\n";
const sectionSyntax = ":::section\r\n  selected\r\n\r\n:::cell\r\nnested\r\n:::\r\n:::\r\n";
const exactSelection = {
	path: [0, 0, 0],
	expectedKind: exactSection.kind,
	expectedName: "section",
	expectedSource: sectionSyntax,
} as const;
const selectedTab: MicaNode = {
	kind: "container",
	name: "tab",
	title: "Selected tab",
	colons: 0,
	open_line: "tab: Selected tab\r\n",
	children: [exactSection, leaf("Unselected section\r\n")],
	close_line: "",
};
const selectionRoot: MicaNode[] = [
	{
		kind: "container",
		name: "tabs",
		title: "",
		colons: 0,
		open_line: "",
		children: [selectedTab, leaf("Sibling tab\r\n")],
		close_line: "",
	},
];
assert.equal(resolveExactCopySelection(selectionRoot, exactSelection), exactSection);
assert.equal(
	resolveExactCopySelection(selectionRoot, {
		...exactSelection,
		expectedSource: sectionSyntax.replace("selected", "stale"),
	}),
	null,
	"a changed selection is rejected rather than falling back to its tab",
);
assert.equal(
	resolveExactCopySelection(selectionRoot, { ...exactSelection, path: [0, 9] }),
	null,
	"a stale path never resolves an ancestor",
);
for (const includeMicaSyntax of [false, true]) {
	for (const includeOuterContainer of [false, true]) {
		for (const includeLineNumbers of [false, true]) {
			for (const lineNumberScope of ["content", "output"] as const) {
				const value = copyNodes([exactSection], {
					includeMicaSyntax,
					includeOuterContainer,
					includeLineNumbers,
					lineNumberScope,
				});
				assert.doesNotMatch(value, /Sibling tab|Unselected section|tab:|:::grid/);
				if (!includeLineNumbers && !includeOuterContainer)
					assert.equal(value, includeMicaSyntax ? sectionSyntax : sectionPlain);
			}
		}
	}
}

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
assert.equal(copyNodes(friendlyTabs, { includeMicaSyntax: false, includeOuterContainer: false }), "\n\tindented\n\n\n");
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
assert.equal(
	copyText("\r\n  authored\t\r\n\r\n", { includeMicaSyntax: false, includeOuterContainer: false }),
	"\r\n  authored\t\r\n\r\n",
	"authored boundary whitespace remains byte-exact",
);

console.log("COPY PAYLOAD OK");
