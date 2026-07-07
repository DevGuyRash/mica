/**
 * WasmBridge — the single gateway between the TypeScript shell and the Rust
 * `mica-core` WebAssembly module.
 *
 * Design (wired in M1): the `.wasm` is inlined into `main.js` as a `Uint8Array`
 * via esbuild's `binary` loader (never `fetch()`, which is sandboxed in the
 * Electron renderer), then instantiated once. Hot paths (scan/parse) exchange
 * data through typed-array views over `wasm.memory.buffer` — no JSON on any hot
 * path. This module keeps that surface small and typed.
 */

/** The typed surface the plugin consumes; grows through the milestones. */
export interface MicaCore {
	version(): string;
	hashContent(text: string): string;
	newId(): string;
	// M1: scan(bytes) / parseBlock(bytes); M4: diffPair / diffNway / makePatch.
}

/**
 * Loads and instantiates the WASM core. Stubbed in M0; M1 replaces the body
 * with the real `wasm-pack` init over the inlined binary and adds a cached
 * singleton accessor (`getCore`).
 */
export async function initCore(): Promise<MicaCore> {
	throw new Error("Mica core wiring lands in M1.");
}
