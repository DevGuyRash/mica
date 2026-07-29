import type { LedgerEvent } from "../wasm/bridge";

/** Hard safety limits shared with the CLI. The ledger remains append-only; a
 * derived cache may avoid repeat parsing, but these bounds cap every cold read. */
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
export const MAX_LEDGER_LINE_BYTES = 1024 * 1024;
export const MAX_LEDGER_EVENTS = 1_000_000;
/** Fixed (rather than wall-clock-relative) upper bound shared with Rust. */
export const MAX_EVENT_TIMESTAMP_MS = 32_503_680_000_000; // 3000-01-01 UTC
export const MAX_FUTURE_EVENT_SKEW_MS = 86_400_000; // 24 hours

const HASH_PATTERN = /^b3:(?:[0-9a-f]{16}|[0-9a-f]{64})$/;

const LEDGER_EVENT_TYPES = new Set([
	"add-version",
	"replace-version",
	"set-head",
	"label",
	"checkpoint",
	"move-head",
	"version-label",
	"version-visibility",
]);

/** Raised when valid JSON names a ledger event type this reader cannot safely
 * interpret. This is a format-compatibility failure, not a torn record. */
export class UnknownLedgerEventTypeError extends Error {
	constructor(readonly eventType: string) {
		super(`Mica: unknown ledger event type ${JSON.stringify(eventType)}`);
		this.name = "UnknownLedgerEventTypeError";
	}
}

export type InvalidLedgerEventField =
	"eid" | "ts" | "block" | "hash" | "target" | "parent" | "source" | "cause" | "visible";

/** Raised when a syntactically valid replacement record cannot be interpreted
 * safely. Unlike malformed JSON, this record advertises a storage contract and
 * therefore represents sidecar corruption rather than a recoverable torn tail. */
export class InvalidLedgerEventError extends Error {
	constructor(
		readonly eventType: string,
		readonly field: InvalidLedgerEventField,
		readonly reason: string,
	) {
		super(`Mica: invalid ${eventType} event: ${field} ${reason}`);
		this.name = "InvalidLedgerEventError";
	}
}

/** Fail closed when a syntactically valid record advertises a typed ledger
 * contract this reader does not understand. Untyped JSON remains ignorable. */
export function assertKnownLedgerEventType(value: unknown): void {
	if (!isRecord(value) || typeof value.type !== "string") return;
	if (!LEDGER_EVENT_TYPES.has(value.type)) throw new UnknownLedgerEventTypeError(value.type);
}

export function isObjectHash(value: unknown): value is string {
	return typeof value === "string" && HASH_PATTERN.test(value);
}

/** Validate exactly the JSON-domain constraints the TypeScript and Rust
 * readers share. JS cannot represent larger integer timestamps exactly. */
export function isLedgerEvent(value: unknown): value is LedgerEvent {
	return isLedgerEventAt(value, Date.now());
}

export function isLedgerEventAt(value: unknown, nowMs: number): value is LedgerEvent {
	if (!isRecord(value)) return false;
	if (typeof value.eid !== "string" || !value.eid.length || typeof value.block !== "string" || !value.block.length)
		return false;
	const latest = latestEventTimestamp(nowMs);
	if (!Number.isSafeInteger(value.ts) || (value.ts as number) < 0 || (value.ts as number) > latest) {
		return false;
	}
	switch (value.type) {
		case "add-version":
			return (
				isObjectHash(value.hash) &&
				optionalString(value.label) &&
				optionalString(value.origin) &&
				optionalHash(value.parent)
			);
		case "replace-version":
			return isObjectHash(value.hash) && typeof value.target === "string" && value.target.length > 0;
		case "set-head":
			return isObjectHash(value.hash);
		case "label":
			return isObjectHash(value.hash) && optionalString(value.label);
		case "checkpoint":
			return (
				isObjectHash(value.hash) &&
				optionalId(value.parent) &&
				optionalId(value.source) &&
				optionalString(value.cause)
			);
		case "move-head":
			return optionalId(value.target);
		case "version-label":
			return typeof value.target === "string" && value.target.length > 0 && optionalString(value.label);
		case "version-visibility":
			return typeof value.target === "string" && value.target.length > 0 && typeof value.visible === "boolean";
		default:
			return false;
	}
}

export interface ParsedLedger {
	readonly events: LedgerEvent[];
	readonly recordCount: number;
}

export function parseLedgerDocument(text: string): ParsedLedger {
	const events: LedgerEvent[] = [];
	const byEid = new Map<string, LedgerEvent>();
	const now = Date.now();
	let cursor = 0;
	let records = 0;
	while (cursor <= text.length) {
		const newline = text.indexOf("\n", cursor);
		const end = newline < 0 ? text.length : newline;
		const raw = text.slice(cursor, end);
		const trimmed = raw.trim();
		if (trimmed) {
			records += 1;
			if (records > MAX_LEDGER_EVENTS) {
				throw new Error(`Mica: ledger exceeds ${MAX_LEDGER_EVENTS} records`);
			}
			// The character check avoids an unnecessary allocation for obviously
			// oversized ASCII lines; the byte check handles non-ASCII correctly.
			if (raw.length > MAX_LEDGER_LINE_BYTES || utf8ByteLength(raw) > MAX_LEDGER_LINE_BYTES) {
				throw new Error(`Mica: ledger line exceeds ${MAX_LEDGER_LINE_BYTES} bytes`);
			}
			let value: unknown;
			try {
				value = JSON.parse(trimmed);
			} catch {
				// Ignore malformed/truncated records. A later verified append always
				// starts on a fresh line, so one damaged tail cannot hide recovery.
				value = undefined;
			}
			assertKnownLedgerEventType(value);
			assertValidTypedLedgerEventAt(value, now);
			if (isLedgerEventAt(value, now)) {
				const previous = byEid.get(value.eid);
				if (previous && !sameLedgerEvent(previous, value)) {
					throw new Error(`Mica: ledger eid ${JSON.stringify(value.eid)} has conflicting events`);
				}
				if (!previous) {
					byEid.set(value.eid, value);
					events.push(value);
				}
			}
		}
		if (newline < 0) break;
		cursor = newline + 1;
	}
	return { events, recordCount: records };
}

export function parseLedgerText(text: string): LedgerEvent[] {
	return parseLedgerDocument(text).events;
}

export interface BatchStatus {
	readonly present: readonly LedgerEvent[];
	readonly missing: readonly LedgerEvent[];
	readonly conflictEids: readonly string[];
}

/** Match append recovery by immutable event identity, while rejecting an eid
 * that was already used for different data. */
export function classifyEventBatch(existing: readonly LedgerEvent[], intended: readonly LedgerEvent[]): BatchStatus {
	const byEid = new Map<string, LedgerEvent>();
	for (const event of existing) byEid.set(event.eid, event);
	const present: LedgerEvent[] = [];
	const missing: LedgerEvent[] = [];
	const conflictEids: string[] = [];
	for (const event of intended) {
		const found = byEid.get(event.eid);
		if (!found) missing.push(event);
		else if (sameLedgerEvent(found, event)) present.push(event);
		else conflictEids.push(event.eid);
	}
	return { present, missing, conflictEids };
}

export function validateEventBatch(events: readonly LedgerEvent[]): void {
	const byEid = new Map<string, LedgerEvent>();
	const now = Date.now();
	for (const event of events) {
		assertValidTypedLedgerEventAt(event, now);
		if (!isLedgerEventAt(event, now)) throw new Error("Mica: refusing to append an invalid ledger event");
		const previous = byEid.get(event.eid);
		if (previous && !sameLedgerEvent(previous, event)) {
			throw new Error(`Mica: append batch reuses eid ${JSON.stringify(event.eid)} for different events`);
		}
		if (previous) throw new Error(`Mica: append batch contains duplicate eid ${JSON.stringify(event.eid)}`);
		byEid.set(event.eid, event);
	}
}

/** Return authoritative fold order without mutating file-order input. Repair
 * uses this before reminting eids so same-timestamp dependencies survive a
 * Sync line-union whose JSONL order is arbitrary. */
export function orderedLedgerEvents(events: readonly LedgerEvent[]): LedgerEvent[] {
	return [...events].sort((left, right) => left.ts - right.ts || compareAscii(left.eid, right.eid));
}

/** Remint event identities without changing fold semantics. Sorting the minted
 * ids before assigning them removes any dependency on UUID-generator monotonicity
 * within one millisecond. Replacement targets are rewritten from a complete
 * old-to-new eid map so copied histories remain self-contained. */
export function remintLedgerEventIds(events: readonly LedgerEvent[], newEventId: () => string): LedgerEvent[] {
	return remintOrderedLedgerEventIds(orderedLedgerEvents(events), newEventId);
}

/** Faster remint for an already-authoritatively-ordered history. Callers that
 * cache that order can clone it repeatedly without re-sorting the source. A
 * partial history containing an unresolved replacement target is rejected. */
export function remintOrderedLedgerEventIds(
	orderedEvents: readonly LedgerEvent[],
	newEventId: () => string,
): LedgerEvent[] {
	const eids = orderedEvents.map(() => newEventId()).sort(compareAscii);
	const remintedBySource = new Map<string, string>();
	for (let index = 0; index < orderedEvents.length; index++) {
		const event = orderedEvents[index];
		const eid = eids[index];
		if (remintedBySource.has(event.eid)) {
			throw new Error(`Mica: cannot remint history with duplicate source eid ${JSON.stringify(event.eid)}`);
		}
		if (index > 0 && eids[index - 1] === eid) {
			throw new Error(`Mica: event id generator produced duplicate eid ${JSON.stringify(eid)}`);
		}
		remintedBySource.set(event.eid, eid);
	}
	const remintRef = (event: LedgerEvent, target: string): string => {
		const reminted = remintedBySource.get(target);
		if (!reminted) {
			throw new Error(`Mica: event ${JSON.stringify(event.eid)} has absent target ${JSON.stringify(target)}`);
		}
		return reminted;
	};
	return orderedEvents.map((event) => {
		const eid = remintedBySource.get(event.eid);
		if (!eid) throw new Error(`Mica: missing reminted eid for ${JSON.stringify(event.eid)}`);
		switch (event.type) {
			case "replace-version":
				return { ...event, eid, target: remintRef(event, event.target) };
			case "checkpoint":
				return {
					...event,
					eid,
					parent: event.parent ? remintRef(event, event.parent) : event.parent,
					source: event.source ? remintRef(event, event.source) : event.source,
				};
			case "move-head":
				return { ...event, eid, target: event.target ? remintRef(event, event.target) : event.target };
			case "version-label":
			case "version-visibility":
				return { ...event, eid, target: remintRef(event, event.target) };
			default:
				return { ...event, eid };
		}
	});
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameLedgerEvent(left: LedgerEvent, right: LedgerEvent): boolean {
	if (left.type !== right.type || left.eid !== right.eid || left.ts !== right.ts || left.block !== right.block) {
		return false;
	}
	if (left.type === "add-version" && right.type === "add-version") {
		return (
			left.hash === right.hash &&
			(left.label ?? null) === (right.label ?? null) &&
			(left.origin ?? null) === (right.origin ?? null) &&
			(left.parent ?? null) === (right.parent ?? null)
		);
	}
	if (left.type === "replace-version" && right.type === "replace-version") {
		return left.hash === right.hash && left.target === right.target;
	}
	if (left.type === "label" && right.type === "label")
		return left.hash === right.hash && (left.label ?? null) === (right.label ?? null);
	if (left.type === "checkpoint" && right.type === "checkpoint") {
		return (
			left.hash === right.hash &&
			(left.parent ?? null) === (right.parent ?? null) &&
			(left.source ?? null) === (right.source ?? null) &&
			(left.cause ?? null) === (right.cause ?? null)
		);
	}
	if (left.type === "move-head" && right.type === "move-head")
		return (left.target ?? null) === (right.target ?? null);
	if (left.type === "version-label" && right.type === "version-label")
		return left.target === right.target && (left.label ?? null) === (right.label ?? null);
	if (left.type === "version-visibility" && right.type === "version-visibility")
		return left.target === right.target && left.visible === right.visible;
	return left.type === "set-head" && right.type === "set-head" && left.hash === right.hash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "string";
}

function optionalHash(value: unknown): boolean {
	return value === undefined || value === null || isObjectHash(value);
}

function optionalId(value: unknown): boolean {
	return value === undefined || value === null || (typeof value === "string" && value.length > 0);
}

function assertValidTypedLedgerEventAt(value: unknown, nowMs: number): void {
	if (!isRecord(value) || typeof value.type !== "string" || !LEDGER_EVENT_TYPES.has(value.type)) return;
	const invalid = (field: InvalidLedgerEventField, reason: string): never => {
		throw new InvalidLedgerEventError(value.type as string, field, reason);
	};
	if (typeof value.eid !== "string" || value.eid.length === 0) {
		invalid("eid", "must be a non-empty string");
	}
	if (
		!Number.isSafeInteger(value.ts) ||
		(value.ts as number) < 0 ||
		(value.ts as number) > latestEventTimestamp(nowMs)
	) {
		invalid("ts", "must be an accepted non-negative integer timestamp");
	}
	if (typeof value.block !== "string" || value.block.length === 0) {
		invalid("block", "must be a non-empty string");
	}
	switch (value.type) {
		case "add-version":
			if (!isObjectHash(value.hash)) invalid("hash", "must be a valid object hash");
			if (!optionalHash(value.parent)) invalid("parent", "must be a valid object hash when present");
			break;
		case "replace-version":
		case "set-head":
		case "label":
			if (!isObjectHash(value.hash)) invalid("hash", "must be a valid object hash");
			if (value.type === "replace-version" && (typeof value.target !== "string" || value.target.length === 0))
				invalid("target", "must be a non-empty string");
			break;
		case "checkpoint":
			if (!isObjectHash(value.hash)) invalid("hash", "must be a valid object hash");
			if (!optionalId(value.parent)) invalid("parent", "must be a non-empty string when present");
			if (!optionalId(value.source)) invalid("source", "must be a non-empty string when present");
			if (!optionalString(value.cause)) invalid("cause", "must be a string when present");
			break;
		case "move-head":
			if (!optionalId(value.target)) invalid("target", "must be a non-empty string when present");
			break;
		case "version-label":
			if (typeof value.target !== "string" || value.target.length === 0)
				invalid("target", "must be a non-empty string");
			break;
		case "version-visibility":
			if (typeof value.target !== "string" || value.target.length === 0)
				invalid("target", "must be a non-empty string");
			if (typeof value.visible !== "boolean") invalid("visible", "must be a boolean");
			break;
	}
}

function latestEventTimestamp(nowMs: number): number {
	return Math.min(MAX_EVENT_TIMESTAMP_MS, Math.max(0, nowMs) + MAX_FUTURE_EVENT_SKEW_MS);
}

/** Exact UTF-8 size with constant auxiliary space (TextEncoder allocates an
 * additional buffer as large as the ledger). Lone surrogates encode as U+FFFD. */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const low = text.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				bytes += 4;
				i += 1;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}
