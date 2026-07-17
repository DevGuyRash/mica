import init, {
	apply_op,
	content_signature,
	diff,
	ensure_ids,
	fold_ledger,
	has_content,
	hash_content,
	make_patch,
	mica_version,
	migrate_tabs,
	new_id,
	parse_block,
	reconcile,
	replace_block_content,
	scan_view,
	serialize,
	set_block_attr,
} from "./pkg/mica_core.js";
import wasmBinary from "./pkg/mica_core_bg.wasm";

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
let initializing: Promise<void> | null = null;

/**
 * Instantiate the inlined WASM core exactly once. The `.wasm` is bundled into
 * `main.js` as a `Uint8Array` (esbuild `binary` loader) and passed straight to
 * `WebAssembly.instantiate` — no `fetch()`, so it works in the Electron sandbox
 * and on mobile. Call during `onload()`.
 */
export async function initCore(): Promise<void> {
	if (ready) return;
	initializing ??= initializeCore();
	try {
		await initializing;
	} catch (error) {
		initializing = null;
		throw error;
	}
}

async function initializeCore(): Promise<void> {
	await init({ module_or_path: wasmBinary });
	ready = true;
	// After instantiation the inlined bytes are dead weight (the engine keeps
	// its own compiled module), yet the bundle's module-scope binding would pin
	// all ~450 KB for the session. Detach the buffer to release it now, where
	// supported; nothing reads `wasmBinary` again once `ready` is set, and on
	// an init failure we never detach, so a retry still has the bytes.
	const buf = wasmBinary.buffer as { transfer?: (newByteLength?: number) => ArrayBufferLike };
	if (typeof buf.transfer === "function") buf.transfer(0);
}

export function coreVersion(): string {
	return mica_version();
}

export function hashContent(text: string): string {
	return hash_content(text);
}

/**
 * A hash of a block's *content* only — the trimmed, non-empty leaf texts,
 * sorted so order doesn't matter and structure/titles/whitespace are ignored.
 * Versioning gates on this so adding empty tabs/cells, reordering, or renaming
 * never mints a version; only real prose changes do. Computed in the shared
 * Rust core so the plugin and the `mica` CLI can never disagree.
 */
export function contentSignature(content: string): string {
	return content_signature(content);
}

/** True if a block has any non-empty prose (used to skip versioning empty scaffolds). */
export function hasContent(content: string): boolean {
	return has_content(content);
}

export function newId(): string {
	return new_id();
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
	readonly start: number;
	readonly end: number;
	readonly content_start: number;
	readonly content_end: number;
	readonly fence_len: number;
	readonly closed: boolean;
	readonly id: string | null;
	readonly name: string | null;
	/** All fence-header attributes, in header order. */
	readonly attrs: readonly (readonly [string, string])[];
}

// scan_view is a pure function of the document, and independent subsystems
// (Live Preview, widget ops, the version engine, the versions modal, the
// public API) re-scan the same text within one interaction. A single
// latest-doc slot dedupes those WASM round-trips while retaining at most one
// document string — usually the editor's own live copy, so ~zero extra memory.
// Hits alias the same array: callers treat scan results as immutable.
let lastScan: { doc: string; blocks: readonly BlockView[] } | null = null;

/** Locate all ` ```mica ` blocks with CodeMirror (UTF-16) offsets. */
export function scanBlocksView(src: string): readonly BlockView[] {
	if (lastScan && lastScan.doc === src) return lastScan.blocks;
	const blocks = scan_view(src) as BlockView[];
	lastScan = { doc: src, blocks };
	return blocks;
}

/** Replace block `id`'s content in `doc`, returning the full new document. */
export function replaceBlockContent(doc: string, id: string, newContent: string): string | null {
	// A block's content must end at the closing fence's own line, so terminate it —
	// otherwise newline-free content (revert / branch-edit / API) glues onto the ```
	// and the block stops closing.
	const c = newContent.length && !newContent.endsWith("\n") ? `${newContent}\n` : newContent;
	return replace_block_content(doc, id, c) as string | null;
}

/** Insert a fresh `id=` into any ` ```mica ` block that lacks one. */
export function ensureIds(doc: string): string {
	return ensure_ids(doc);
}

/**
 * Set / replace / remove one fence-header attribute on block `id` (per-block
 * appearance, names). `value: null` removes. Returns the new document, or
 * `null` when the block is missing / the key is `id` / the value can't
 * round-trip through the attr grammar.
 */
export function setBlockAttr(doc: string, id: string, key: string, value: string | null): string | null {
	return set_block_attr(doc, id, key, value ?? undefined) as string | null;
}

/**
 * Apply one structural op to a CST in the shared Rust reducer.
 * Returns the (possibly unchanged) tree and whether it changed.
 */
export function applyOpCore(cst: Cst, op: unknown): { changed: boolean; cst: Cst } {
	return apply_op(cst, op) as { changed: boolean; cst: Cst };
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
	| { type: "set-head"; eid: string; ts: number; block: string; hash: string }
	| { type: "label"; eid: string; ts: number; block: string; hash: string; label?: string | null };

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

/** `line`/`line-char` = line rows with word- or char-level intra-line
 *  emphasis; whole-document `word`/`char` modes remain for the CLI. */
export type DiffGranularity = "line" | "word" | "char" | "line-word" | "line-char";

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

/**
 * Every built-in Obsidian callout type plus its aliases
 * (https://help.obsidian.md/callouts), case-insensitive. Used as the default
 * migration allowlist so version callouts of ANY built-in type are imported.
 */
export const OBSIDIAN_CALLOUT_TYPES = [
	"note",
	"abstract",
	"summary",
	"tldr",
	"info",
	"todo",
	"tip",
	"hint",
	"important",
	"success",
	"check",
	"done",
	"question",
	"help",
	"faq",
	"warning",
	"caution",
	"attention",
	"failure",
	"fail",
	"missing",
	"danger",
	"error",
	"bug",
	"example",
	"quote",
	"cite",
].join(", ");

/**
 * Convert every legacy ` ```tabs ` block in `doc` into a ` ```mica ` block.
 * `calloutTypes` is a comma-separated allowlist of callout types imported as
 * version history; an empty string imports every callout type.
 */
export function migrateTabs(doc: string, calloutTypes = OBSIDIAN_CALLOUT_TYPES): MigrationResult {
	return migrate_tabs(doc, calloutTypes) as MigrationResult;
}
