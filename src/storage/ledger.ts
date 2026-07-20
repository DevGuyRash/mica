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
	if (typeof value.eid !== "string" || typeof value.block !== "string") return false;
	const latest = Math.min(MAX_EVENT_TIMESTAMP_MS, Math.max(0, nowMs) + MAX_FUTURE_EVENT_SKEW_MS);
	if (!Number.isSafeInteger(value.ts) || (value.ts as number) < 0 || (value.ts as number) > latest) {
		return false;
	}
	if (!isObjectHash(value.hash)) return false;
	switch (value.type) {
		case "add-version":
			return optionalString(value.label) && optionalString(value.origin) && optionalHash(value.parent);
		case "set-head":
			return true;
		case "label":
			return optionalString(value.label);
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
			try {
				const value: unknown = JSON.parse(trimmed);
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
			} catch (error) {
				// A conflicting duplicate is an integrity failure, not a malformed
				// line that can safely be ignored.
				if (error instanceof Error && error.message.startsWith("Mica: ledger eid ")) throw error;
				// Ignore malformed/truncated records. A later verified append always
				// starts on a fresh line, so one damaged tail cannot hide recovery.
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
	const byEid = new Map(existing.map((event) => [event.eid, event]));
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
	for (const event of events) {
		if (!isLedgerEvent(event)) throw new Error("Mica: refusing to append an invalid ledger event");
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
 * within one millisecond. */
export function remintLedgerEventIds(events: readonly LedgerEvent[], newEventId: () => string): LedgerEvent[] {
	return remintOrderedLedgerEventIds(orderedLedgerEvents(events), newEventId);
}

/** Faster remint for an already-authoritatively-ordered history. Callers that
 * cache that order can clone it repeatedly without re-sorting the source. */
export function remintOrderedLedgerEventIds(
	orderedEvents: readonly LedgerEvent[],
	newEventId: () => string,
): LedgerEvent[] {
	const eids = orderedEvents.map(() => newEventId()).sort(compareAscii);
	return orderedEvents.map((event, index) => ({ ...event, eid: eids[index] }));
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameLedgerEvent(left: LedgerEvent, right: LedgerEvent): boolean {
	if (
		left.type !== right.type ||
		left.eid !== right.eid ||
		left.ts !== right.ts ||
		left.block !== right.block ||
		left.hash !== right.hash
	) {
		return false;
	}
	if (left.type === "add-version" && right.type === "add-version") {
		return (
			(left.label ?? null) === (right.label ?? null) &&
			(left.origin ?? null) === (right.origin ?? null) &&
			(left.parent ?? null) === (right.parent ?? null)
		);
	}
	if (left.type === "label" && right.type === "label") return (left.label ?? null) === (right.label ?? null);
	return left.type === "set-head" && right.type === "set-head";
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
