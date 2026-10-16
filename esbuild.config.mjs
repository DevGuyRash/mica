import esbuild from "esbuild";
import process from "node:process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

const notices = [
	readFileSync(new URL("./LICENSE", import.meta.url), "utf8"),
	readFileSync(new URL("./THIRD-PARTY-NOTICES.txt", import.meta.url), "utf8"),
].join("\n\n");
if (notices.includes("*/")) throw new Error("License notices cannot contain a block-comment terminator");

const banner = `/*!
Mica — generated bundle, do not edit directly.

${notices.trim()}
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

if (process.argv[2] === "wasm") {
	const env = { ...process.env };
	const remaps = [`--remap-path-prefix=${homedir()}=/build`, `--remap-path-prefix=${process.cwd()}=/src/mica`];
	const args = [
		"build",
		"crates/mica-core",
		"--target",
		"web",
		"--release",
		"--out-dir",
		"../../src/wasm/pkg",
		"--",
		"--locked",
	];
	// Cargo gives encoded flags precedence, including an explicitly empty value.
	if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
		env.CARGO_ENCODED_RUSTFLAGS += `${env.CARGO_ENCODED_RUSTFLAGS ? "\x1f" : ""}${remaps.join("\x1f")}`;
	} else if (env.RUSTFLAGS !== undefined) {
		env.CARGO_ENCODED_RUSTFLAGS = [...env.RUSTFLAGS.split(/\s+/).filter(Boolean), ...remaps].join("\x1f");
	} else {
		args.push("--config", `target.wasm32-unknown-unknown.rustflags=${JSON.stringify(remaps)}`);
	}
	const result = spawnSync("wasm-pack", args, { env, stdio: "inherit" });
	if (result.error) console.error(`Unable to start wasm-pack: ${result.error.message}`);
	process.exitCode = result.status ?? 1;
} else if (production) {
	await esbuild.build(buildOptions);
} else {
	const context = await esbuild.context(buildOptions);
	await context.watch();
}
