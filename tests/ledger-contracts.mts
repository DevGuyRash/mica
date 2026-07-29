import assert from "node:assert/strict";
import {
	classifyEventBatch,
	assertKnownLedgerEventType,
	InvalidLedgerEventError,
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
	remintOrderedLedgerEventIds,
	UnknownLedgerEventTypeError,
	utf8ByteLength,
	validateEventBatch,
} from "../src/storage/ledger.ts";
import type { LedgerEvent } from "../src/wasm/bridge.ts";

const legacyHash = `b3:${"a".repeat(16)}`;
const fullHash = `b3:${"b".repeat(64)}`;
const replacementHash = `b3:${"c".repeat(64)}`;
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
const replacement: LedgerEvent = {
	type: "replace-version",
	eid: "replace-1",
	ts: 3,
	block: "block",
	target: "add-1",
	hash: replacementHash,
};
assert.equal(isLedgerEvent(replacement), true);
assert.equal(isLedgerEvent({ ...replacement, target: 7 }), false);
assert.equal(isLedgerEvent({ ...replacement, target: "" }), false);
assert.equal(isLedgerEvent({ ...replacement, hash: "not-a-hash" }), false);
assert.equal(isLedgerEvent({ ...replacement, eid: "" }), false);
assert.equal(isLedgerEvent({ ...replacement, block: "" }), false);
const checkpoint: LedgerEvent = {
	type: "checkpoint",
	eid: "checkpoint-1",
	ts: 4,
	block: "block",
	hash: fullHash,
	parent: "checkpoint-0",
	source: "checkpoint-source",
	cause: "restore",
};
assert.equal(isLedgerEvent(checkpoint), true);
assert.equal(isLedgerEvent({ ...checkpoint, parent: "" }), false);
assert.equal(isLedgerEvent({ ...checkpoint, source: "" }), false);
assert.equal(isLedgerEvent({ ...checkpoint, cause: 7 }), false);
assert.equal(
	isLedgerEvent({
		type: "move-head",
		eid: "move-1",
		ts: 5,
		block: "block",
		target: "checkpoint-1",
	}),
	true,
);
assert.equal(
	isLedgerEvent({
		type: "version-visibility",
		eid: "visibility-1",
		ts: 6,
		block: "block",
		target: "checkpoint-1",
		visible: false,
	}),
	true,
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
assert.throws(
	() => parseLedgerText(`${JSON.stringify(base)}\n${JSON.stringify({ type: "future-ledger-event" })}\n`),
	(error: unknown) => error instanceof UnknownLedgerEventTypeError && error.eventType === "future-ledger-event",
	"well-formed typed events from an unknown ledger format fail closed",
);
assert.deepEqual(
	parseLedgerText("{}\nnull\n[]\n"),
	[],
	"well-formed non-events without a typed contract remain ignorable",
);
for (const [field, value] of [
	["target", ""],
	["target", 7],
	["hash", ""],
	["hash", "not-a-hash"],
	["eid", ""],
	["eid", 7],
	["block", ""],
	["block", 7],
	["ts", ""],
	["ts", -1],
	["ts", 1.5],
] as const) {
	assert.throws(
		() => parseLedgerText(`${JSON.stringify({ ...replacement, [field]: value })}\n`),
		(error: unknown) =>
			error instanceof InvalidLedgerEventError && error.eventType === "replace-version" && error.field === field,
		`well-formed replace-version with invalid ${field} fails closed`,
	);
}
for (const invalid of [
	{ ...checkpoint, eid: "" },
	{ ...checkpoint, block: "" },
	{ ...checkpoint, parent: "" },
	{ ...checkpoint, source: "" },
	{
		type: "move-head",
		eid: "move-invalid",
		ts: 5,
		block: "block",
		target: "",
	},
	{
		type: "version-visibility",
		eid: "visibility-invalid",
		ts: 6,
		block: "block",
		target: "checkpoint-1",
		visible: "no",
	},
]) {
	assert.throws(
		() => parseLedgerText(`${JSON.stringify(invalid)}\n`),
		(error: unknown) => error instanceof InvalidLedgerEventError,
		`well-formed ${invalid.type} with invalid identity data fails closed`,
	);
}
assert.throws(
	() => parseLedgerText(`${JSON.stringify(replacement)}\n${JSON.stringify({ ...replacement, target: "add-2" })}\n`),
	/conflicting events/,
	"replacement target participates in event identity",
);

const second: LedgerEvent = { type: "label", eid: "e-2", ts: 2, block: "block", hash: fullHash, label: "v2" };
assert.deepEqual(classifyEventBatch([base], [base, second]), {
	present: [base],
	missing: [second],
	conflictEids: [],
});
assert.deepEqual(classifyEventBatch([{ ...base, hash: legacyHash }], [base]).conflictEids, ["e-1"]);
assert.throws(() => validateEventBatch([base, base]), /duplicate eid/);
assert.throws(
	() => validateEventBatch([{ ...replacement, target: "" }]),
	(error: unknown) => error instanceof InvalidLedgerEventError && error.field === "target",
	"append validation uses the same fail-closed replacement contract as reads",
);
assert.deepEqual(
	orderedLedgerEvents([
		{ ...second, eid: "z", ts: 2 },
		{ ...replacement, eid: "y", ts: 2 },
		{ ...base, eid: "b", ts: 1 },
		{ ...base, eid: "a", ts: 1 },
	]).map((event) => event.eid),
	["a", "b", "y", "z"],
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
assert.doesNotThrow(() => assertKnownLedgerEventType(replacement));
assert.throws(() => assertKnownLedgerEventType({ type: "future-ledger-event" }), UnknownLedgerEventTypeError);

const replacementHistory: LedgerEvent[] = [
	{ type: "set-head", eid: "old-head", ts: 3, block: "old", hash: legacyHash },
	{
		type: "replace-version",
		eid: "old-replace",
		ts: 2,
		block: "old",
		target: "old-add",
		hash: replacementHash,
	},
	{ type: "add-version", eid: "old-add", ts: 1, block: "old", hash: legacyHash },
];
const clonedIds = ["new-z", "new-a", "new-m"];
const cloned = remintLedgerEventIds(replacementHistory, () => clonedIds.shift() ?? "missing");
const clonedAdd = cloned.find((event) => event.type === "add-version");
const clonedReplacement = cloned.find((event) => event.type === "replace-version");
assert.deepEqual(
	cloned.map((event) => [event.type, event.eid]),
	[
		["add-version", "new-a"],
		["replace-version", "new-m"],
		["set-head", "new-z"],
	],
	"complete histories retain authoritative ordering while all event ids are reminted",
);
assert.equal(clonedReplacement?.target, clonedAdd?.eid, "replacement targets follow the reminted add event id");
assert.throws(
	() => remintLedgerEventIds([{ ...replacement, target: "absent-add" }], () => "new-replace"),
	/absent target/,
	"partial histories cannot clone a replacement without its target",
);
assert.throws(
	() =>
		remintOrderedLedgerEventIds(
			[
				{ type: "add-version", eid: "same", ts: 1, block: "old", hash: legacyHash },
				{ type: "set-head", eid: "same", ts: 2, block: "old", hash: legacyHash },
			],
			(() => {
				let generated = 0;
				return () => `generated-${(generated += 1)}`;
			})(),
		),
	/duplicate source eid/,
);
assert.throws(
	() =>
		remintOrderedLedgerEventIds(
			[
				{ type: "add-version", eid: "first", ts: 1, block: "old", hash: legacyHash },
				{ type: "set-head", eid: "second", ts: 2, block: "old", hash: legacyHash },
			],
			() => "duplicate-generated-id",
		),
	/event id generator produced duplicate eid/,
	"sorted generated ids still reject duplicates without a second identity set",
);

console.log("LEDGER CONTRACTS OK");
