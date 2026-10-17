/**
 * Source-owned types for the generated functions consumed by bridge.ts.
 * Structured serde values remain unknown until the bridge's domain assertions.
 * The initializer's unused output is opaque; raw WASM ABI members are not this contract.
 * esbuild checks these signatures and normalizes generated serde types after generation.
 */
declare module "*/pkg/mica_core.js" {
	export function apply_op(cst: unknown, op: unknown): unknown;
	export function apply_op_text(content: string, op: unknown): unknown;
	export function apply_ops_text(content: string, ops: unknown): unknown;
	export function content_signature(content: string): string;
	export function diff(base: string, other: string, granularity: string, context: number): unknown;
	export function ensure_ids(doc: string): string;
	export function fold_ledger(events: unknown): unknown;
	export function has_content(content: string): boolean;
	export function hash_content(text: string): string;
	export function make_patch(base: string, other: string, context: number): string;
	export function mica_version(): string;
	export function migrate_tabs(doc: string, callout_types: string): unknown;
	export function new_id(): string;
	export function storage_layout(folder?: string | null): unknown;
	export function note_paths(note_id: string, folder?: string | null): unknown;
	export function object_paths(full_hash: string, folder?: string | null): unknown;
	export function is_managed_path(vault_relative: string, folder?: string | null): boolean;
	export function validate_store_folder(folder: string): string;
	export function note_id(source: string): string | undefined;
	export function set_note_id(source: string, expected: string | null | undefined, id: string): string;
	export function validate_store_marker(marker: unknown): unknown;
	export function validate_store_location(location: unknown): unknown;
	export function resolve_object_hash(hash: string, aliases: unknown): string;
	export function parse_block(content: string): unknown;
	export function reconcile(content: unknown, sidecar: unknown): unknown;
	export function rewrite_block_id_at(doc: string, block_start: number, expected_id: string, new_id: string): unknown;
	export function replace_block_content(doc: string, id: string, new_content: string): unknown;
	export function scan_view(src: string): unknown;
	export function serialize(cst: unknown): string;
	export function set_block_attr(doc: string, id: string, key: string, value?: string | null): unknown;
	export function set_block_attr_edit(doc: string, id: string, key: string, value?: string | null): unknown;
	export function guarded_block_content_edit(doc: string, id: string, expected: string, new_content: string): unknown;
	export function guarded_block_content_edit_at(
		doc: string,
		block_start: number,
		expected: string,
		new_content: string,
	): unknown;

	export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
	export default function __wbg_init(
		module_or_path?:
			| { module_or_path: InitInput | Promise<InitInput> }
			| InitInput
			| Promise<InitInput>,
	): Promise<unknown>;
}
