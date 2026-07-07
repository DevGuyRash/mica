// esbuild's `binary` loader turns a `.wasm` import into a `Uint8Array` at build
// time. This ambient declaration gives that import its type.
declare module "*.wasm" {
	const bytes: Uint8Array;
	export default bytes;
}
