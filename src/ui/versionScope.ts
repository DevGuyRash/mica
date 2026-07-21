import { parseBlock } from "../wasm/bridge";
import { buildScopeIndexFromCst, type ScopeIndex } from "./versionScopeCore";

export * from "./versionScopeCore";

/** Runtime adapter: structural parsing remains owned by the Rust core. */
export function buildScopeIndex(source: string): ScopeIndex {
	return buildScopeIndexFromCst(source, parseBlock(source));
}
