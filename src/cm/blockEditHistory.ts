import { Annotation } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { Notice } from "obsidian";
import { scanBlocksView, type BlockEdit, type BlockView } from "../wasm/bridge";

const MAX_ENTRIES = 100;
const MAX_BYTES = 8 * 1024 * 1024;
const RAW_GROUP_MS = 750;

export const micaHistoryReplay = Annotation.define<boolean>();

interface HistoryPart {
	readonly blockId: string;
	readonly before: string;
	readonly after: string;
}

interface HistoryEntry {
	parts: readonly HistoryPart[];
	readonly ids: ReadonlySet<string>;
	readonly group: string | null;
	updatedAt: number;
	bytes: number;
	state: "done" | "undone";
}

const histories = new WeakMap<EditorView, BlockEditHistory>();

export function blockEditHistory(view: EditorView): BlockEditHistory {
	let history = histories.get(view);
	if (!history) {
		history = new BlockEditHistory(view);
		histories.set(view, history);
	}
	return history;
}

/**
 * Editor-session, stable-id history for Mica blocks. Replays replace only exact
 * current block preimages; unrelated note edits can neither move the target nor
 * be overwritten. Storage is bounded by entry count and retained source bytes.
 */
export class BlockEditHistory {
	private readonly entries: HistoryEntry[] = [];
	private firstEntry = 0;
	private retainedBytes = 0;

	constructor(private readonly view: EditorView) {}

	canUndo(blockId: string): boolean {
		return this.findUndo(blockId) !== null;
	}

	canRedo(blockId: string): boolean {
		return this.findRedo(blockId) !== null;
	}

	/** Record one already-validated Mica transaction before it is dispatched. */
	recordChanges(doc: string, edits: readonly BlockEdit[], blockIds: readonly string[], group = null): void {
		const blocks = scanBlocksView(doc);
		const selected = uniqueClosedBlocks(blocks, blockIds);
		if (!selected) return;
		const parts: HistoryPart[] = [];
		for (const [blockId, block] of selected) {
			const relevant = edits.filter((edit) => edit.from >= block.start && edit.to <= block.end);
			if (!relevant.length) continue;
			const before = doc.slice(block.start, block.end);
			const after = applyEdits(before, relevant, block.start);
			if (before !== after) parts.push({ blockId, before, after });
		}
		this.record(parts, group, Date.now());
	}

	/** Record a version-engine mutation that was applied through the vault and
	 * will subsequently be reflected into this editor by Obsidian. */
	recordDocuments(beforeDoc: string, afterDoc: string, blockIds: readonly string[]): void {
		const beforeBlocks = scanBlocksView(beforeDoc);
		const afterBlocks = scanBlocksView(afterDoc);
		const beforeById = uniqueClosedBlocks(beforeBlocks, blockIds);
		const afterById = uniqueClosedBlocks(afterBlocks, blockIds);
		if (!beforeById || !afterById) return;
		const parts: HistoryPart[] = [];
		for (const [blockId, before] of beforeById) {
			const after = afterById.get(blockId);
			if (!after) return;
			parts.push({
				blockId,
				before: beforeDoc.slice(before.start, before.end),
				after: afterDoc.slice(after.start, after.end),
			});
		}
		this.record(parts, null, Date.now());
	}

	/** Acknowledge an exact state reached outside CodeMirror, such as the Undo
	 * action on a Revert-to-HEAD notice. The next applicable entry alone may
	 * advance, and only when every retained outer-block image matches. */
	acknowledgeExactState(doc: string, blockIds: readonly string[], state: "done" | "undone"): boolean {
		const ids = new Set(blockIds);
		if (!ids.size) return false;
		const blocks = uniqueClosedBlocks(scanBlocksView(doc), blockIds);
		if (!blocks) return false;
		const previousState = state === "undone" ? "done" : "undone";
		const start = state === "undone" ? this.entries.length - 1 : this.firstEntry;
		const end = state === "undone" ? this.firstEntry - 1 : this.entries.length;
		const step = state === "undone" ? -1 : 1;
		for (let index = start; index !== end; index += step) {
			const entry = this.entries[index];
			if (entry.state !== previousState || !intersects(entry.ids, ids)) continue;
			if (!sameIds(entry.ids, ids)) continue;
			const field = state === "undone" ? "before" : "after";
			let exact = true;
			for (const part of entry.parts) {
				const block = blocks.get(part.blockId);
				if (!block || doc.slice(block.start, block.end) !== part[field]) {
					exact = false;
					break;
				}
			}
			if (!exact) continue;
			entry.state = state;
			return true;
		}
		return false;
	}

	/** Capture direct typing while the selected raw block remains unambiguous. */
	recordRawUpdate(update: ViewUpdate, previous: BlockView | null): void {
		if (!previous?.id || !update.docChanged) return;
		if (update.transactions.some((transaction) => transaction.annotation(micaHistoryReplay))) return;
		const userTyped = update.transactions.some(
			(transaction) => transaction.isUserEvent("input") || transaction.isUserEvent("delete"),
		);
		if (!userTyped) return;
		let inside = true;
		update.changes.iterChangedRanges((fromA, toA) => {
			if (fromA < previous.start || toA > previous.end) inside = false;
		});
		if (!inside) return;
		const current = uniqueClosedBlocks(scanBlocksView(update.state.doc.toString()), [previous.id])?.get(
			previous.id,
		);
		if (!current) return;
		const before = update.startState.doc.sliceString(previous.start, previous.end);
		const after = update.state.doc.sliceString(current.start, current.end);
		this.record([{ blockId: previous.id, before, after }], `raw:${previous.id}`, Date.now());
	}

	undo(blockId: string): boolean {
		const index = this.findUndo(blockId);
		if (index === null) return false;
		const entry = this.entries[index];
		// CodeMirror rebuilds replacement widgets synchronously during dispatch;
		// publish the next state first so the rebuilt footer exposes Redo.
		entry.state = "undone";
		if (!this.replay(entry, "undo")) {
			entry.state = "done";
			return false;
		}
		return true;
	}

	redo(blockId: string): boolean {
		const index = this.findRedo(blockId);
		if (index === null) return false;
		const entry = this.entries[index];
		entry.state = "done";
		if (!this.replay(entry, "redo")) {
			entry.state = "undone";
			return false;
		}
		return true;
	}

	private record(parts: readonly HistoryPart[], group: string | null, now: number): void {
		const changed = parts.filter((part) => part.before !== part.after);
		if (!changed.length) return;
		const ids = new Set(changed.map((part) => part.blockId));
		this.discardUndone(ids);
		const previous = this.entries.length > this.firstEntry ? this.entries.at(-1) : undefined;
		if (
			group &&
			previous?.state === "done" &&
			previous.group === group &&
			now - previous.updatedAt <= RAW_GROUP_MS &&
			sameIds(previous.ids, ids) &&
			previous.parts.every((part, index) => part.after === changed[index]?.before)
		) {
			this.retainedBytes -= previous.bytes;
			const merged = previous.parts.map((part, index) => ({ ...part, after: changed[index].after }));
			previous.parts = merged;
			previous.updatedAt = now;
			previous.bytes = entryBytes(merged);
			this.retainedBytes += previous.bytes;
			this.evict();
			return;
		}
		const bytes = entryBytes(changed);
		this.entries.push({ parts: changed, ids, group, updatedAt: now, bytes, state: "done" });
		this.retainedBytes += bytes;
		this.evict();
	}

	private replay(entry: HistoryEntry, direction: "undo" | "redo"): boolean {
		const doc = this.view.state.doc.toString();
		const blocks = scanBlocksView(doc);
		const byId = uniqueClosedBlocks(
			blocks,
			entry.parts.map((part) => part.blockId),
		);
		if (!byId) return this.refuse("the block is missing or its id is ambiguous");
		const changes: Array<{ from: number; to: number; insert: string }> = [];
		for (const part of entry.parts) {
			const block = byId.get(part.blockId);
			if (!block) return this.refuse("the block is missing or its id is ambiguous");
			const expected = direction === "undo" ? part.after : part.before;
			const insert = direction === "undo" ? part.before : part.after;
			if (doc.slice(block.start, block.end) !== expected)
				return this.refuse("the block changed after this history entry was recorded");
			changes.push({ from: block.start, to: block.end, insert });
		}
		this.view.dispatch({
			changes: changes.sort((left, right) => left.from - right.from),
			annotations: micaHistoryReplay.of(true),
			userEvent: direction,
		});
		return true;
	}

	private refuse(reason: string): false {
		new Notice(`Mica: cannot apply block-local history because ${reason}.`);
		return false;
	}

	private findUndo(blockId: string): number | null {
		for (let i = this.entries.length - 1; i >= this.firstEntry; i--) {
			const entry = this.entries[i];
			if (entry.state === "done" && entry.ids.has(blockId)) return i;
		}
		return null;
	}

	private findRedo(blockId: string): number | null {
		for (let i = this.firstEntry; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (entry.state === "undone" && entry.ids.has(blockId)) return i;
		}
		return null;
	}

	private evict(): void {
		while (this.entries.length - this.firstEntry > MAX_ENTRIES || this.retainedBytes > MAX_BYTES) {
			const entry = this.entries[this.firstEntry++];
			if (entry) this.retainedBytes -= entry.bytes;
		}
		// Head indexing makes routine eviction O(1); compact only occasionally,
		// keeping the amortized cost constant without retaining stale entries.
		if (this.firstEntry === this.entries.length) {
			this.entries.length = 0;
			this.firstEntry = 0;
		} else if (this.firstEntry >= 50 && this.firstEntry * 2 >= this.entries.length) {
			this.entries.splice(0, this.firstEntry);
			this.firstEntry = 0;
		}
	}

	private discardUndone(ids: ReadonlySet<string>): void {
		let write = this.firstEntry;
		for (let read = this.firstEntry; read < this.entries.length; read++) {
			const entry = this.entries[read];
			if (entry.state === "undone" && intersects(entry.ids, ids)) {
				this.retainedBytes -= entry.bytes;
				continue;
			}
			this.entries[write++] = entry;
		}
		this.entries.length = write;
	}
}

function applyEdits(source: string, edits: readonly BlockEdit[], offset: number): string {
	const ordered = [...edits].sort((left, right) => right.from - left.from);
	const parts: string[] = [];
	let cursor = source.length;
	for (const edit of ordered) {
		parts.push(source.slice(edit.to - offset, cursor), edit.insert);
		cursor = edit.from - offset;
	}
	parts.push(source.slice(0, cursor));
	parts.reverse();
	return parts.join("");
}

function entryBytes(parts: readonly HistoryPart[]): number {
	let bytes = 0;
	for (const part of parts) bytes += (part.before.length + part.after.length) * 2;
	return bytes;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	for (const id of left) if (right.has(id)) return true;
	return false;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const id of left) if (!right.has(id)) return false;
	return true;
}

/** Resolve requested stable ids in one block pass, rejecting missing or
 * duplicate ids so every caller retains the same fail-closed contract. */
function uniqueClosedBlocks(
	blocks: readonly BlockView[],
	blockIds: readonly string[],
): ReadonlyMap<string, BlockView> | null {
	const wanted = new Set(blockIds);
	const found = new Map<string, BlockView>();
	for (const block of blocks) {
		if (!block.closed || !block.id || !wanted.has(block.id)) continue;
		if (found.has(block.id)) return null;
		found.set(block.id, block);
	}
	if (found.size !== wanted.size) return null;
	const ordered = new Map<string, BlockView>();
	for (const blockId of wanted) ordered.set(blockId, found.get(blockId) as BlockView);
	return ordered;
}
