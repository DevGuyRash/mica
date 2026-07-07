import init, { hash_content, mica_version, new_id, parse_block, scan, serialize } from "./pkg/mica_core.js";
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
