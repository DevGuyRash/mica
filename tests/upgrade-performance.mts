import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { copyNodes } from "../src/ui/copyPayload.ts";
import { SEARCH_WORKER_SOURCE } from "../src/ui/searchWorker.ts";
import { visibleTextStats } from "../src/ui/textStats.ts";
import { buildScopeIndexFromCst } from "../src/ui/versionScopeCore.ts";
import { versionLineageRoute } from "../src/ui/versionLineage.ts";
import { buildScopeTransition } from "../src/ui/versionTransition.ts";
import { searchVersions } from "../src/ui/versionWindow.ts";
import type { Cst, MicaNode } from "../src/wasm/bridge.ts";

const MIB = 1024 * 1024;
const TIME_BUDGET_MS = {
	search: 750,
	statistics: 2_000,
	copy: 1_250,
	scopeIndex: 1_750,
	scopeTransition: 2_500,
	versionSearch: 500,
	lineage: 250,
} as const;
const HEAP_BUDGET_BYTES = 192 * MIB;
const ARRAY_BUFFER_BUDGET_BYTES = 64 * MIB;
const RANGE_BUDGET_BYTES = 16 * MIB;

interface Measurement<T> {
	value: T;
	elapsed: number;
}

function timed<T>(name: keyof typeof TIME_BUDGET_MS, run: () => T): Measurement<T> {
	const started = performance.now();
	const value = run();
	const elapsed = performance.now() - started;
	assert.ok(elapsed <= TIME_BUDGET_MS[name], `${name} took ${elapsed.toFixed(1)} ms`);
	return { value, elapsed };
}

function assertNearLinear(name: string, small: number, large: number): void {
	// A doubled fixture gets generous fixed headroom for worker startup, JIT,
	// GC, and CI scheduling, but may not show super-linear growth.
	const limit = Math.max(small * 3.75, small + 100);
	assert.ok(large <= limit, `${name} scaled from ${small.toFixed(1)} ms to ${large.toFixed(1)} ms`);
}

async function searchDocument(
	document: string,
	needle = "target",
): Promise<{ count: number; bytes: number; elapsed: number }> {
	const wrapper = `
const { parentPort } = require("node:worker_threads");
const self = { postMessage: (value, transfer) => parentPort.postMessage(value, transfer) };
${SEARCH_WORKER_SOURCE}
parentPort.on("message", (data) => self.onmessage({ data }));
`;
	const worker = new Worker(wrapper, { eval: true });
	const started = performance.now();
	try {
		const response = await new Promise<{ ok: boolean; ranges?: ArrayBuffer; error?: string }>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("large search worker timed out")), 5_000);
			worker.once("message", (message) => {
				clearTimeout(timeout);
				resolve(message as { ok: boolean; ranges?: ArrayBuffer; error?: string });
			});
			worker.once("error", reject);
			worker.postMessage({
				id: 1,
				type: "scan",
				doc: document,
				needle,
				regex: false,
				flags: "",
				matchCase: true,
			});
		});
		assert.equal(response.ok, true, response.error ?? "search worker rejected the request");
		const ranges = new Uint32Array(response.ranges!);
		const elapsed = performance.now() - started;
		assert.ok(elapsed <= TIME_BUDGET_MS.search, `search took ${elapsed.toFixed(1)} ms`);
		assert.ok(ranges.byteLength <= RANGE_BUDGET_BYTES, "search range storage exceeded its compact-memory budget");
		return { count: ranges.length / 2, bytes: ranges.byteLength, elapsed };
	} finally {
		await worker.terminate();
	}
}

const searchLine = `target ${"x".repeat(1016)}\n`;
const smallDocument = searchLine.repeat(512);
const largeDocument = searchLine.repeat(1024);
assert.ok(largeDocument.length >= MIB, "large fixture must remain at least one MiB");

const memoryBefore = process.memoryUsage();
const searchSmall = await searchDocument(smallDocument);
const searchLarge = await searchDocument(largeDocument);
assert.equal(searchSmall.count, 512);
assert.equal(searchLarge.count, 1024);
assert.equal(searchLarge.bytes, 1024 * 2 * Uint32Array.BYTES_PER_ELEMENT);
assertNearLinear("search", searchSmall.elapsed, searchLarge.elapsed);

// Dense ranges exercise compact O(matches) storage instead of only the common
// sparse case. 100k matches should occupy exactly two Uint32 offsets each.
const denseMatches = 100_000;
const denseSearch = await searchDocument("target ".repeat(denseMatches));
assert.equal(denseSearch.count, denseMatches);
assert.equal(denseSearch.bytes, denseMatches * 2 * Uint32Array.BYTES_PER_ELEMENT);

const statisticsSmall = timed("statistics", () => visibleTextStats(smallDocument));
const statisticsLarge = timed("statistics", () => visibleTextStats(largeDocument));
assert.equal(statisticsLarge.value.lines, 1024);
assert.equal(statisticsLarge.value.words, 2048);
assertNearLinear("statistics", statisticsSmall.elapsed, statisticsLarge.elapsed);

const copyFixture = (document: string): string =>
	copyNodes([{ kind: "leaf", text: document, is_code: false } satisfies MicaNode], {
		includeMicaSyntax: true,
		includeOuterContainer: true,
		includeLineNumbers: true,
		lineNumberScope: "output",
	});
const copySmall = timed("copy", () => copyFixture(smallDocument));
const copyLarge = timed("copy", () => copyFixture(largeDocument));
assert.ok(copyLarge.value.length > largeDocument.length);
assert.match(copyLarge.value, /^\s*1 │ ```mica/);
assertNearLinear("copy", copySmall.elapsed, copyLarge.elapsed);

function scopeFixture(count: number, revision = "original"): { source: string; cst: Cst } {
	const children: MicaNode[] = [];
	let source = "";
	for (let index = 0; index < count; index++) {
		const open = `:::section Scope ${index}\n`;
		const body = `Scope ${index}\n${revision} ${"y".repeat(2016)}\n`;
		const close = ":::\n";
		source += open + body + close;
		children.push({
			kind: "container",
			name: "section",
			title: `Scope ${index}`,
			colons: 3,
			open_line: open,
			close_line: close,
			children: [{ kind: "leaf", text: body, is_code: false }],
		});
	}
	return { source, cst: { children } };
}

const smallScopes = scopeFixture(256);
const largeScopes = scopeFixture(512);
assert.ok(largeScopes.source.length >= MIB, "scope fixture must remain at least one MiB");
const scopeSmall = timed("scopeIndex", () => buildScopeIndexFromCst(smallScopes.source, smallScopes.cst));
const scopeLarge = timed("scopeIndex", () => buildScopeIndexFromCst(largeScopes.source, largeScopes.cst));
assert.equal(scopeLarge.value.source, largeScopes.source);
assert.equal(scopeLarge.value.scopes.length, 513);
assert.ok(
	scopeLarge.value.scopes.every((item) => !("source" in item)),
	"scope entries must retain ranges, not source copies",
);
assertNearLinear("scope indexing", scopeSmall.elapsed, scopeLarge.elapsed);

const changedSmall = scopeFixture(256, "revised");
const changedLarge = scopeFixture(512, "revised");
const changedSmallIndex = buildScopeIndexFromCst(changedSmall.source, changedSmall.cst);
const changedLargeIndex = buildScopeIndexFromCst(changedLarge.source, changedLarge.cst);
const transitionSmall = timed("scopeTransition", () => buildScopeTransition(scopeSmall.value, changedSmallIndex));
const transitionLarge = timed("scopeTransition", () => buildScopeTransition(scopeLarge.value, changedLargeIndex));
assert.equal(transitionLarge.value.forward.size, 513);
assert.equal(transitionLarge.value.reverse.size, 513);
assertNearLinear("scope transition matching", transitionSmall.elapsed, transitionLarge.elapsed);

const duplicateScopeFixture = (count: number): { source: string; cst: Cst } => {
	const node = (): MicaNode => ({
		kind: "container",
		name: "section",
		title: "",
		colons: 3,
		open_line: ":::section\n",
		close_line: ":::\n",
		children: [{ kind: "leaf", text: "identical empty-like body\n", is_code: false }],
	});
	const children = Array.from({ length: count }, node);
	return { source: ":::section\nidentical empty-like body\n:::\n".repeat(count), cst: { children } };
};
const duplicateSmallFixture = duplicateScopeFixture(200);
const duplicateLargeFixture = duplicateScopeFixture(400);
const duplicateSmallIndex = buildScopeIndexFromCst(duplicateSmallFixture.source, duplicateSmallFixture.cst);
const duplicateLargeIndex = buildScopeIndexFromCst(duplicateLargeFixture.source, duplicateLargeFixture.cst);
const duplicateSmall = timed("scopeTransition", () => buildScopeTransition(duplicateSmallIndex, duplicateSmallIndex));
const duplicateLarge = timed("scopeTransition", () => buildScopeTransition(duplicateLargeIndex, duplicateLargeIndex));
assertNearLinear("duplicate-heavy scope matching", duplicateSmall.elapsed, duplicateLarge.elapsed);

const versionRows = Array.from({ length: 10_000 }, (_, index) => ({
	n: index + 1,
	meta: {
		versionId: `version-${index}`,
		hash: `b3:${index.toString(16).padStart(64, "0")}`,
		label: index % 3 ? `Routine snapshot ${index}` : `Milestone ${index}`,
		ts: Date.UTC(2025, 0, 1) + index,
		effectiveParentVersionId: index ? `version-${index - 1}` : null,
	},
}));
const versionSearch = timed("versionSearch", () => searchVersions(versionRows, "milestone", 100));
assert.equal(versionSearch.value.length, 100);
const lineage = timed("lineage", () =>
	versionLineageRoute(
		versionRows.slice(0, 201),
		versionRows[0].meta.versionId,
		versionRows[200].meta.versionId,
		"working",
		null,
	),
);
assert.ok(lineage.value, "a 200-checkpoint lineage resolves");
assert.equal(lineage.value.length, 200);

const memoryAfter = process.memoryUsage();
const heapDelta = Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed);
const arrayBufferDelta = Math.max(0, memoryAfter.arrayBuffers - memoryBefore.arrayBuffers);
assert.ok(heapDelta <= HEAP_BUDGET_BYTES, `fixture retained ${(heapDelta / MIB).toFixed(1)} MiB of heap`);
assert.ok(
	arrayBufferDelta <= ARRAY_BUFFER_BUDGET_BYTES,
	`fixture retained ${(arrayBufferDelta / MIB).toFixed(1)} MiB of ArrayBuffers`,
);

console.log(
	`UPGRADE PERFORMANCE OK — search ${searchSmall.elapsed.toFixed(1)}→${searchLarge.elapsed.toFixed(1)} ms; ` +
		`dense ${denseSearch.elapsed.toFixed(1)} ms/${denseSearch.bytes} B ranges; ` +
		`statistics ${statisticsSmall.elapsed.toFixed(1)}→${statisticsLarge.elapsed.toFixed(1)} ms; ` +
		`copy ${copySmall.elapsed.toFixed(1)}→${copyLarge.elapsed.toFixed(1)} ms; ` +
		`scope ${scopeSmall.elapsed.toFixed(1)}→${scopeLarge.elapsed.toFixed(1)} ms; ` +
		`transition ${transitionSmall.elapsed.toFixed(1)}→${transitionLarge.elapsed.toFixed(1)} ms; ` +
		`duplicates ${duplicateSmall.elapsed.toFixed(1)}→${duplicateLarge.elapsed.toFixed(1)} ms; ` +
		`version search ${versionSearch.elapsed.toFixed(1)} ms; lineage ${lineage.elapsed.toFixed(1)} ms; ` +
		`heap ${(heapDelta / MIB).toFixed(1)} MiB, ArrayBuffers ${(arrayBufferDelta / MIB).toFixed(1)} MiB`,
);
