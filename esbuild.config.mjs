import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

const banner = `/*
 * Mica — generated bundle, do not edit directly.
 * License: MIT
 */`;

const buildOptions = {
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	target: "es2022",
	platform: "browser",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	minify: production,
	outfile: "main.js",
	// The Rust core is inlined as a Uint8Array (never fetch() — sandboxed in Electron).
	loader: { ".wasm": "binary" },
	// wasm-pack's web glue references import.meta.url only in a dead default path
	// (we always pass the inlined bytes to init), so neutralize it for a clean CJS bundle.
	define: { "import.meta.url": JSON.stringify("file:///mica") },
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
};

if (production) {
	await esbuild.build(buildOptions);
} else {
	const context = await esbuild.context(buildOptions);
	await context.watch();
}
