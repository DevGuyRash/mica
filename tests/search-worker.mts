import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { SEARCH_WORKER_SOURCE } from "../src/ui/searchWorker.ts";
import { buildSearchFlags } from "../src/ui/searchFlags.ts";

interface Request {
	id: number;
	type: "scan" | "replace";
	doc: string;
	needle: string;
	regex: boolean;
	flags: string;
	matchCase: boolean;
	global?: boolean;
	replacement?: string;
	target?: number;
}

async function run(
	request: Request,
): Promise<{ ok: boolean; text?: string; ranges?: ArrayBuffer; replacements?: string[]; error?: string }> {
	const wrapper = `
const { parentPort } = require("node:worker_threads");
const self = { postMessage: (value, transfer) => parentPort.postMessage(value, transfer) };
${SEARCH_WORKER_SOURCE}
parentPort.on("message", (data) => self.onmessage({ data }));
`;
	const worker = new Worker(wrapper, { eval: true });
	try {
		return await new Promise((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.postMessage(request);
		});
	} finally {
		await worker.terminate();
	}
}

const replace = async (needle: string, doc: string, replacement: string, flags = "u") =>
	run({ id: 1, type: "replace", doc, needle, regex: true, flags, matchCase: true, replacement, target: -1 });

assert.equal((await replace("(?<a>x)|(?<b>y)", "x", "$<b>")).text, "");
assert.equal((await replace("(?<x>a)?b", "b", "$<x>-")).text, "-");
assert.equal((await replace("(a)", "a", "$1|$&|$$|$<missing>")).text, "a|a|$|$<missing>");
assert.equal((await replace("(?<word>a)", "a", "$<word>")).text, "a");

const lookbehind = await run({
	id: 2,
	type: "scan",
	doc: "€12 €34",
	needle: "(?<=€)\\d+",
	regex: true,
	flags: "gu",
	matchCase: true,
});
assert.equal(new Uint32Array(lookbehind.ranges!).length / 2, 2);
const zeroWidth = await run({
	id: 3,
	type: "scan",
	doc: "😀😀",
	needle: "(?=😀)",
	regex: true,
	flags: "gu",
	matchCase: true,
});
assert.deepEqual([...new Uint32Array(zeroWidth.ranges!)], [0, 0, 2, 2]);

assert.deepEqual(buildSearchFlags({ matchCase: false, multiline: true, dotAll: true, otherFlags: "dv" }), {
	ok: true,
	flags: "imsdv",
});
assert.deepEqual(buildSearchFlags({ matchCase: true, multiline: false, dotAll: false, otherFlags: "d" }), {
	ok: true,
	flags: "d",
});
assert.match(
	buildSearchFlags({ matchCase: true, multiline: false, dotAll: false, otherFlags: "g" }).error,
	/Global search checkbox/i,
);
assert.match(
	buildSearchFlags({ matchCase: true, multiline: false, dotAll: false, otherFlags: "uu" }).error,
	/duplicate/i,
);
assert.match(
	buildSearchFlags({ matchCase: true, multiline: false, dotAll: false, otherFlags: "m" }).error,
	/controlled by the search checkboxes/i,
);

const multilineFlags = buildSearchFlags({ matchCase: true, multiline: true, dotAll: false, otherFlags: "u" });
assert.equal(multilineFlags.ok, true);
const multiline = await run({
	id: 4,
	type: "scan",
	doc: "first\nsecond",
	needle: "^second$",
	regex: true,
	flags: multilineFlags.ok ? multilineFlags.flags : "",
	matchCase: true,
});
assert.equal(new Uint32Array(multiline.ranges!).length / 2, 1);

const dotAllFlags = buildSearchFlags({ matchCase: true, multiline: false, dotAll: true, otherFlags: "u" });
assert.equal(dotAllFlags.ok, true);
const dotAll = await run({
	id: 5,
	type: "scan",
	doc: "first\nsecond",
	needle: "first.second",
	regex: true,
	flags: dotAllFlags.ok ? dotAllFlags.flags : "",
	matchCase: true,
});
assert.equal(new Uint32Array(dotAll.ranges!).length / 2, 1);

const preview = await run({
	id: 6,
	type: "scan",
	doc: "one two one",
	needle: "(?<word>one)",
	regex: true,
	flags: "u",
	matchCase: true,
	global: true,
	replacement: "<$<word>>-$&-$$",
});
assert.deepEqual(preview.replacements, ["<one>-one-$", "<one>-one-$"]);
assert.equal(new Uint32Array(preview.ranges!).length / 2, 2);

const nonGlobal = await run({
	id: 7,
	type: "scan",
	doc: "one two one",
	needle: "one",
	regex: false,
	flags: "",
	matchCase: true,
	global: false,
	replacement: "ONE",
});
assert.deepEqual([...new Uint32Array(nonGlobal.ranges!)], [0, 3]);
assert.deepEqual(nonGlobal.replacements, ["ONE"]);

const zeroWidthPreview = await run({
	id: 8,
	type: "scan",
	doc: "😀😀",
	needle: "(?=😀)",
	regex: true,
	flags: "u",
	matchCase: true,
	global: true,
	replacement: "x",
});
assert.deepEqual([...new Uint32Array(zeroWidthPreview.ranges!)], [0, 0, 2, 2]);
assert.deepEqual(zeroWidthPreview.replacements, ["x", "x"]);

for (const [label, doc, expectedRanges, expectedText] of [
	["isolated high surrogate", "\ud800a", [0, 0, 1, 1], "|\ud800|a"],
	["isolated low surrogate", "\udc00a", [0, 0, 1, 1], "|\udc00|a"],
	["valid surrogate pair", "😀", [0, 0], "|😀"],
] as const) {
	const scan = await run({
		id: 10,
		type: "scan",
		doc,
		needle: "(?=.)",
		regex: true,
		flags: "gu",
		matchCase: true,
		global: true,
		replacement: "|",
	});
	assert.deepEqual([...new Uint32Array(scan.ranges!)], expectedRanges, `${label} scan offsets`);
	assert.deepEqual(scan.replacements, expectedRanges.length ? Array(expectedRanges.length / 2).fill("|") : []);
	const replaced = await replace("(?=.)", doc, "|", "gu");
	assert.equal(replaced.text, expectedText, `${label} replacement`);
}

const nonGlobalReplace = await run({
	id: 9,
	type: "replace",
	doc: "one two one",
	needle: "one",
	regex: false,
	flags: "",
	matchCase: true,
	global: false,
	replacement: "ONE",
	target: -1,
});
assert.equal(nonGlobalReplace.text, "ONE two one");

console.log("SEARCH WORKER OK");
