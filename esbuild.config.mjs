import esbuild from "esbuild";
import process from "node:process";
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { builtinModules } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

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
		...builtinModules,
		"node:*",
	],
};

if (process.argv[2] === "wasm") {
	const env = { ...process.env };
	const home = homedir();
	// Resolve relative cache homes before wasm-pack changes the working directory.
	for (const name of ["CARGO_HOME", "RUSTUP_HOME"]) {
		if (env[name] && !isAbsolute(env[name])) env[name] = resolve(env[name]);
	}
	const roots = [
		[home, "/build"],
		[resolve(env.CARGO_HOME || join(home, ".cargo")), "/build/.cargo"],
		[resolve(env.RUSTUP_HOME || join(home, ".rustup")), "/build/.rustup"],
	];
	if (env.RUSTUP_TOOLCHAIN && isAbsolute(env.RUSTUP_TOOLCHAIN)) {
		roots.push([env.RUSTUP_TOOLCHAIN, "/build/.rustup/toolchains/selected"]);
	}
	roots.push([process.cwd(), "/src/mica"]);
	const prefixes = new Map();
	for (const [from, to] of roots) {
		prefixes.set(from, to);
		try {
			prefixes.set(realpathSync(from), to);
		} catch (error) {
			// Cargo/rustup may create a missing home during the build.
			if (error.code !== "ENOENT") throw error;
		}
	}
	// Rust uses the last matching prefix; nested source/cache roots must win.
	const remaps = [...prefixes]
		.sort(([left], [right]) => left.length - right.length)
		.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
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
