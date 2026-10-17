import esbuild from "esbuild";
import process from "node:process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
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

function assertWasmDeclarations() {
	// Only the bridge's public signatures are consumer contracts. Extra exports and
	// InitOutput's raw WebAssembly ABI may change without affecting those callers.
	const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
	const normalize = (text) =>
		stripComments(text)
			.match(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_$][\w$]*|[^\s]/g)
			?.filter(
				(token, index, tokens) =>
					!(token === "|" && tokens[index - 1] === ":") &&
					!(token === "," && tokens[index + 1] === ")"),
			)
			.map((token) => (token === "any" ? "unknown" : token))
			.join("");
	const contract = stripComments(readFileSync(new URL("./src/wasm/bindings.d.ts", import.meta.url), "utf8")).trim();
	const opening = 'declare module "*/pkg/mica_core.js" {';
	if (!contract.startsWith(opening) || !contract.endsWith("}")) {
		throw new Error("Invalid source-owned WASM consumer contract");
	}
	const generatedUrl = new URL("./src/wasm/pkg/mica_core.d.ts", import.meta.url);
	const generated = readFileSync(generatedUrl, "utf8");
	const declarations = stripComments(generated);
	const bridge = readFileSync(new URL("./src/wasm/bridge.ts", import.meta.url), "utf8");
	const imports =
		/^import\s+[A-Za-z_$][\w$]*\s*,\s*\{([^}]+)\}\s*from\s*["']\.\/pkg\/mica_core\.js["'];/m.exec(bridge);
	if (!imports) throw new Error("Cannot identify the bridge's WASM import contract");
	const names = imports[1].split(",").map((name) => name.trim()).filter(Boolean);
	if (new Set(names).size !== names.length || names.some((name) => !/^[A-Za-z_$][\w$]*$/.test(name))) {
		throw new Error("Review the bridge's WASM imports before checking declarations");
	}
	// wasm-bindgen emits one semicolon-terminated declaration for each JS export.
	const signature = (text, name) => {
		const prefix = name === "default" ? "default\\s+function\\s+[A-Za-z_$][\\w$]*" : `function\\s+${name}`;
		const matches = [...text.matchAll(new RegExp(`\\bexport\\s+${prefix}\\s*(\\([^;]*;)`, "g"))];
		if (matches.length !== 1) throw new Error(`Missing or ambiguous WASM declaration: ${name}`);
		return matches[0][1];
	};
	for (const name of names) {
		if (normalize(signature(contract, name)) !== normalize(signature(declarations, name))) {
			throw new Error(`Generated WASM signature differs from src/wasm/bindings.d.ts: ${name}`);
		}
	}
	const input = (text) => {
		const matches = [...text.matchAll(/\bexport\s+type\s+InitInput\s*=\s*([^;]+;)/g)];
		if (matches.length !== 1) throw new Error("Missing or ambiguous WASM initializer input");
		return normalize(matches[0][1]);
	};
	const initShape = (text) => {
		const match = /^([\s\S]*\))\s*:\s*Promise<[^;]+>;$/.exec(signature(text, "default"));
		if (!match) throw new Error("WASM initializer must return a Promise");
		return normalize(match[1]);
	};
	if (input(contract) !== input(declarations) || initShape(contract) !== initShape(declarations)) {
		throw new Error("Generated WASM initializer differs from src/wasm/bindings.d.ts");
	}
	// Keep postbuild type resolution as honest as the clean-checkout contract.
	// Preserve generated comments and quoted text while changing only type tokens.
	const safe = generated.replace(
		/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\bany\b/g,
		(token) => (token === "any" ? "unknown" : token),
	);
	if (safe !== generated) writeFileSync(generatedUrl, safe);
}

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
	if (result.status === 0) assertWasmDeclarations();
} else if (production) {
	assertWasmDeclarations();
	await esbuild.build(buildOptions);
} else {
	const context = await esbuild.context(buildOptions);
	await context.watch();
}
