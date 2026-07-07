import init, {
	block_content_edit,
	diff,
	ensure_ids,
	fold_ledger,
	hash_content,
	make_patch,
	mica_version,
	migrate_tabs,
	new_id,
	parse_block,
	reconcile,
	replace_block_content,
	scan,
	scan_view,
	serialize,
} from "./pkg/mica_core.js";
import wasmBinary from "./pkg/mica_core_bg.wasm";

/** Byte-offset span of a top-level ` ```mica ` block (mirrors Rust `BlockSpan`). */
export interface BlockSpan {
	start: number;
	end: number;
	fence_char: number;
	fence_len: number;
	content_start: number;
	content_end: number;
	closed: boolean;
}

/** A CST node (mirrors Rust `Node`). */
export type MicaNode =
	| {
			kind: "container";
			name: string;
			title: string;
			colons: number;
			open_line: string;
			children: MicaNode[];
			close_line: string;
	  }
	| { kind: "leaf"; text: string; is_code: boolean };

/** Parsed content of one block (mirrors Rust `Cst`). */
export interface Cst {
	children: MicaNode[];
}

let ready = false;

/**
 * Instantiate the inlined WASM core exactly once. The `.wasm` is bundled into
 * `main.js` as a `Uint8Array` (esbuild `binary` loader) and passed straight to
 * `WebAssembly.instantiate` — no `fetch()`, so it works in the Electron sandbox
 * and on mobile. Call during `onload()`.
 */
export async function initCore(): Promise<void> {
	if (ready) return;
	await init({ module_or_path: wasmBinary });
	ready = true;
}

export function coreVersion(): string {
	return mica_version();
}

export function hashContent(text: string): string {
	return hash_content(text);
}

export function newId(): string {
	return new_id();
}

/** Locate every top-level ` ```mica ` block in a document. */
export function scanBlocks(src: string): BlockSpan[] {
	return scan(src) as BlockSpan[];
}

/** Parse one block's content into a CST. */
export function parseBlock(content: string): Cst {
	return parse_block(content) as Cst;
}

/** Serialize a CST back to source (byte-exact for unedited trees). */
export function serializeCst(cst: Cst): string {
	return serialize(cst);
}

/** A block located with UTF-16 offsets + id/name (mirrors Rust `BlockView`). */
export interface BlockView {
	start: number;
	end: number;
	content_start: number;
	content_end: number;
	fence_len: number;
	closed: boolean;
	id: string | null;
	name: string | null;
}

/** Locate all ` ```mica ` blocks with CodeMirror (UTF-16) offsets. */
export function scanBlocksView(src: string): BlockView[] {
	return scan_view(src) as BlockView[];
}

/** A position-mapped edit (UTF-16 offsets) — mirrors Rust `BlockEdit`. */
export interface BlockEdit {
	from: number;
	to: number;
	insert: string;
}

/**
 * Compute the CodeMirror change that replaces block `id`'s content with
 * `newContent`. Bounds are recomputed from a live scan, so it can never
 * append-instead-of-replace. Returns `null` if the block is not found.
 */
export function blockContentEdit(doc: string, id: string, newContent: string): BlockEdit | null {
	return block_content_edit(doc, id, newContent) as BlockEdit | null;
}

/** Replace block `id`'s content in `doc`, returning the full new document. */
export function replaceBlockContent(doc: string, id: string, newContent: string): string | null {
	return replace_block_content(doc, id, newContent) as string | null;
}

/** Insert a fresh `id=` into any ` ```mica ` block that lacks one. */
export function ensureIds(doc: string): string {
	return ensure_ids(doc);
}

// --- Versioning (mirrors the Rust ledger types) --------------------------

export type LedgerEvent =
	| {
			type: "add-version";
			eid: string;
			ts: number;
			block: string;
			hash: string;
			label?: string | null;
			origin?: string | null;
			/** Lineage: hash this version was derived from (branch/edit-previous). */
			parent?: string | null;
	  }
	| { type: "set-head"; eid: string; ts: number; block: string; hash: string };

export interface VersionMeta {
	hash: string;
	ts: number;
	label: string | null;
}

export interface BlockState {
	head: string | null;
	versions: VersionMeta[];
}

/** Fold an append-only ledger into current per-block state, keyed by block id. */
export function foldLedger(events: LedgerEvent[]): Record<string, BlockState> {
	return fold_ledger(events) as Record<string, BlockState>;
}

// --- Diff (mirrors the Rust diff types) ----------------------------------

export type DiffGranularity = "line" | "word" | "char";

export interface DiffSpan {
	tag: "same" | "emph";
	text: string;
}

export interface DiffChange {
	tag: "equal" | "delete" | "insert";
	value: string;
	inline: DiffSpan[];
}

export interface DiffHunk {
	changes: DiffChange[];
}

export interface DiffResult {
	hunks: DiffHunk[];
	similarity: number;
}

/** Diff `base` vs `other` at the given granularity, grouped into hunks. */
export function diffText(base: string, other: string, granularity: DiffGranularity = "line", context = 3): DiffResult {
	return diff(base, other, granularity, context) as DiffResult;
}

/** A unified-diff patch (line granularity) between `base` and `other`. */
export function makePatch(base: string, other: string, context = 3): string {
	return make_patch(base, other, context);
}

/** Navigate a CST to the node at `path` (child indices from the root). */
export function nodeAtPath(cst: Cst, path: number[]): MicaNode | null {
	let nodes: MicaNode[] = cst.children;
	let node: MicaNode | null = null;
	for (const idx of path) {
		const next = nodes[idx];
		if (!next) return null;
		node = next;
		nodes = next.kind === "container" ? next.children : [];
	}
	return node;
}

// --- Reconciliation (mirrors the Rust reconcile types) -------------------

export interface ContentRef {
	block: string;
	note: string;
}

export interface SidecarRef {
	block: string;
	sidecar: string;
}

export type ReconcileAction =
	| { kind: "orphan-sidecar"; block: string; sidecar: string }
	| { kind: "orphan-block"; block: string; note: string }
	| { kind: "duplicate-block"; block: string; notes: string[] };

/** Classify content vs sidecar block-id indexes into reconciliation actions. */
export function reconcileIndexes(content: ContentRef[], sidecar: SidecarRef[]): ReconcileAction[] {
	return reconcile(content, sidecar) as ReconcileAction[];
}

// --- Migration -----------------------------------------------------------

export interface MigratedVersion {
	label: string;
	status: string;
	content: string;
}

export interface MigratedBlock {
	id: string;
	name: string | null;
	versions: MigratedVersion[];
}

export interface MigrationResult {
	doc: string;
	blocks: MigratedBlock[];
	changed: boolean;
}

/** Convert every legacy ` ```tabs ` block in `doc` into a ` ```mica ` block. */
export function migrateTabs(doc: string): MigrationResult {
	return migrate_tabs(doc) as MigrationResult;
}
