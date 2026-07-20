import assert from "node:assert/strict";
import {
	classifyEventBatch,
	isLedgerEventAt,
	isLedgerEvent,
	isObjectHash,
	MAX_EVENT_TIMESTAMP_MS,
	MAX_FUTURE_EVENT_SKEW_MS,
	MAX_LEDGER_BYTES,
	MAX_LEDGER_EVENTS,
	MAX_LEDGER_LINE_BYTES,
	orderedLedgerEvents,
	parseLedgerText,
	remintLedgerEventIds,
	utf8ByteLength,
	validateEventBatch,
} from "../src/storage/ledger.ts";
import type { LedgerEvent } from "../src/wasm/bridge.ts";

const legacyHash = `b3:${"a".repeat(16)}`;
const fullHash = `b3:${"b".repeat(64)}`;
const base: LedgerEvent = { type: "set-head", eid: "e-1", ts: 0, block: "block", hash: fullHash };

assert.equal(MAX_LEDGER_BYTES, 64 * 1024 * 1024);
assert.equal(MAX_LEDGER_LINE_BYTES, 1024 * 1024);
assert.equal(MAX_LEDGER_EVENTS, 1_000_000);
assert.equal(utf8ByteLength("aé😀\ud800"), new TextEncoder().encode("aé😀\ud800").byteLength);
assert.equal(isObjectHash(legacyHash), true);
assert.equal(isObjectHash(fullHash), true);
assert.equal(isObjectHash(`b3:${"A".repeat(64)}`), false);
assert.equal(isObjectHash(`b3:${"a".repeat(63)}`), false);

assert.equal(isLedgerEvent(base), true);
assert.equal(isLedgerEventAt({ ...base, ts: MAX_EVENT_TIMESTAMP_MS }, MAX_EVENT_TIMESTAMP_MS), true);
assert.equal(isLedgerEventAt({ ...base, ts: MAX_EVENT_TIMESTAMP_MS + 1 }, MAX_EVENT_TIMESTAMP_MS), false);
const deterministicNow = 1_000_000;
assert.equal(isLedgerEventAt({ ...base, ts: deterministicNow + MAX_FUTURE_EVENT_SKEW_MS }, deterministicNow), true);
assert.equal(
	isLedgerEventAt({ ...base, ts: deterministicNow + MAX_FUTURE_EVENT_SKEW_MS + 1 }, deterministicNow),
	false,
);
assert.equal(isLedgerEvent({ ...base, ts: -1 }), false);
assert.equal(isLedgerEvent({ ...base, ts: 1.5 }), false);
assert.equal(
	isLedgerEvent({ type: "add-version", eid: "e-2", ts: 1, block: "block", hash: fullHash, parent: legacyHash }),
	true,
);
assert.equal(
	isLedgerEvent({ type: "add-version", eid: "e-2", ts: 1, block: "block", hash: fullHash, parent: "../x" }),
	false,
);

const parsed = parseLedgerText(`${JSON.stringify(base)}\nnot-json\n{"type":`);
assert.deepEqual(parsed, [base], "malformed records and a torn tail are ignored independently");
assert.deepEqual(
	parseLedgerText(`${JSON.stringify(base)}\n${JSON.stringify(base)}\n`),
	[base],
	"an exact replay of an eid is logically deduplicated",
);
assert.throws(
	() => parseLedgerText(`${JSON.stringify(base)}\n${JSON.stringify({ ...base, hash: legacyHash })}\n`),
	/conflicting events/,
);
assert.throws(() => parseLedgerText("x".repeat(MAX_LEDGER_LINE_BYTES + 1)), /line exceeds/);

const second: LedgerEvent = { type: "label", eid: "e-2", ts: 2, block: "block", hash: fullHash, label: "v2" };
assert.deepEqual(classifyEventBatch([base], [base, second]), {
	present: [base],
	missing: [second],
	conflictEids: [],
});
assert.deepEqual(classifyEventBatch([{ ...base, hash: legacyHash }], [base]).conflictEids, ["e-1"]);
assert.throws(() => validateEventBatch([base, base]), /duplicate eid/);
assert.deepEqual(
	orderedLedgerEvents([
		{ ...second, eid: "z", ts: 2 },
		{ ...base, eid: "b", ts: 1 },
		{ ...base, eid: "a", ts: 1 },
	]).map((event) => event.eid),
	["a", "b", "z"],
	"repair replay order is timestamp then lexical eid, not raw JSONL order",
);
const equalTsHistory: LedgerEvent[] = [
	{ type: "label", eid: "c", ts: 7, block: "old", hash: fullHash, label: "kept" },
	{ type: "set-head", eid: "b", ts: 7, block: "old", hash: fullHash },
	{ type: "add-version", eid: "a", ts: 7, block: "old", hash: fullHash },
];
const deliberatelyUnorderedIds = ["z", "a", "m"];
const reminted = remintLedgerEventIds(equalTsHistory, () => deliberatelyUnorderedIds.shift() ?? "missing");
assert.deepEqual(
	reminted.map((event) => [event.type, event.eid]),
	[
		["add-version", "a"],
		["set-head", "m"],
		["label", "z"],
	],
	"same-ts add/head/label fold order survives a non-monotonic id generator",
);

console.log("LEDGER CONTRACTS OK");
