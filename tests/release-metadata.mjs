import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

async function readText(relativePath) {
	return readFile(path.join(root, relativePath), "utf8");
}

async function readJson(relativePath) {
	return JSON.parse(await readText(relativePath));
}

const [pkg, manifest, versions, cargo, license, rustToolchain, workspace, release, releaseConfig, wdio, buildConfig] =
	await Promise.all([
		readJson("package.json"),
		readJson("manifest.json"),
		readJson("versions.json"),
		readText("Cargo.toml"),
		readText("LICENSE"),
		readText("rust-toolchain.toml"),
		readText("pnpm-workspace.yaml"),
		readText(".github/workflows/release.yml"),
		readJson(".github/obsidian-release.json"),
		readText("wdio.conf.mts"),
		readText("esbuild.config.mjs"),
	]);

const workspaceVersion = cargo.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];

assert.ok(workspaceVersion, "Cargo.toml must declare workspace.package.version");
assert.equal(pkg.version, manifest.version, "package and manifest versions must agree");
assert.equal(workspaceVersion, manifest.version, "Rust workspace and plugin versions must agree");
assert.equal(
	versions[manifest.version],
	manifest.minAppVersion,
	"versions.json must map the release to manifest.minAppVersion",
);
assert.equal(pkg.license, "MIT", "package license must remain MIT");
assert.equal(pkg.packageManager, "pnpm@11.3.0", "pnpm must remain reproducibly pinned");
assert.equal(pkg.engines?.node, ">=22.12.0", "Node floor must satisfy the locked Electron downloader");
assert.equal(pkg.dependencies?.fflate, "0.8.3", "mobile gzip read fallback must remain reproducibly pinned");
assert.equal(pkg.devDependencies?.stylelint, "17.6.0", "official CSS scanner tooling must remain pinned");
assert.equal(pkg.devDependencies?.["stylelint-no-unsupported-browser-features"], "8.1.1");
assert.equal(pkg.scripts["lint:scanner-css"], "stylelint styles.css --config stylelint.obsidian-scanner.json");
assert.ok(pkg.scripts["lint:obsidian"].split(" && ").includes("pnpm run lint:scanner-css"));
const scannerCss = await readJson("stylelint.obsidian-scanner.json");
assert.equal(scannerCss.ignoreDisables, true, "CSS scanner rules must not be suppressed inline");
assert.equal(scannerCss.rules["declaration-no-important"][1].severity, "warning");
assert.deepEqual(scannerCss.rules["plugin/no-unsupported-browser-features"][1].browsers, ["electron >= 39"]);

assert.equal(versions["0.1.0"], undefined, "unreleased versions must not be advertised");
assert.match(rustToolchain, /^channel\s*=\s*"1\.97\.1"$/m, "rust-toolchain.toml must pin the CI Rust toolchain");
assert.match(
	workspace,
	/^\s*serialize-javascript:\s*7\.0\.7$/m,
	"pnpm workspace must force the audited serialize-javascript version",
);
assert.match(workspace, /^\s*diff:\s*8\.0\.4$/m, "pnpm workspace must force the audited diff version");
assert.match(release, /tool:\s*wasm-pack@0\.15\.0,cargo-deny@0\.20\.2/, "release tools must remain pinned");
assert.match(release, /\n\s+workflow_dispatch:/, "manual retry must remain available");
assert.match(release, /^\s+push:/m, "main pushes must start automated validation and publication");
assert.doesNotMatch(release, /^\s+schedule:/m, "release validation is event-driven, not scheduled");
assert.match(
	pkg.scripts["release:validate"],
	/cargo clippy --workspace --all-targets --locked -- -D warnings/,
	"Clippy must use Cargo.lock",
);
assert.match(
	pkg.scripts["release:validate"],
	/cargo build --release -p mica-cli --locked/,
	"CLI release build must use Cargo.lock",
);
for (const gate of [
	"audit:prod",
	"build",
	"check",
	"lint:obsidian",
	"test:release",
	"test:version-stress",
	"check:release:assets",
	"smoke",
]) {
	assert.ok(
		pkg.scripts["release:validate"].split(" && ").includes(`pnpm run ${gate}`),
		`hosted release validation must run ${gate}`,
	);
}
assert.match(pkg.scripts["release:validate"], /cargo deny check advisories/, "release must audit Rust dependencies");
assert.match(pkg.scripts["release:validate"], /cargo fmt --all -- --check/, "release must check Rust formatting");
assert.equal(releaseConfig.repository, "DevGuyRash/mica");
assert.equal(releaseConfig.assetDirectory, ".");
assert.equal(
	pkg.scripts["release:qualify"],
	"pnpm run release:validate && pnpm run e2e && pnpm run e2e:minimum && pnpm run e2e:mobile",
	"full native qualification must remain available separately from hosted validation",
);
assert.equal(
	releaseConfig.qualificationEvidenceRequired,
	false,
	"GitHub upload must not claim or require external device/Sync/cutover acceptance",
);
assert.match(
	pkg.scripts.wasm,
	/^node esbuild\.config\.mjs wasm(?:\s|$)/,
	"WASM build must use the shared build config",
);
assert.match(buildConfig, /"--",\s*"--locked"/, "wasm-pack must pass --locked to Cargo");
assert.match(pkg.scripts["test:rust"], /--locked/, "Rust tests must use Cargo.lock");
assert.equal(pkg.scripts["test:sidecar-fallback"], "node tests/sidecar-fallback.mjs");

for (const workflow of [release]) {
	for (const [, action, revision] of workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)/gm)) {
		assert.match(revision, /^[0-9a-f]{40}$/, `${action} must be pinned to a full commit SHA`);
	}
}

// Shared protocol tests cover the exact three public assets, source/evidence
// bindings and immutable draft-before-publish behavior with a fake host.
assert.equal(pkg.scripts["test:release"], "node --test tests/release-contract.test.mjs");
assert.match(release, /node scripts\/release\.mjs stage/);
assert.match(release, /node scripts\/release\.mjs publish/);

const escapedMinVersion = manifest.minAppVersion.replaceAll(".", "\\.");
assert.match(wdio, new RegExp(`MINIMUM_APP_VERSION = "${escapedMinVersion}"`));
assert.equal(pkg.scripts["test:e2e-config"], "node --import tsx --test tests/e2e-config.test.mjs");
assert.ok(
	pkg.scripts.check.split(" && ").includes("pnpm run test:e2e-config"),
	"aggregate checks must exercise real capabilities against pinned compatibility evidence",
);
assert.match(wdio, /selected === "desktop-latest"/);
assert.equal(pkg.scripts["release:advisory"], "pnpm run e2e:latest");
assert.match(release, /Advisory product compatibility[\s\S]*?continue-on-error: true/);
assert.match(license, /^MIT License$/m, "LICENSE must contain the MIT license text");
assert.match(license, /Permission is hereby granted, free of charge/, "LICENSE must contain the MIT permission grant");

if (process.env.GITHUB_REF_TYPE === "tag") {
	assert.equal(
		process.env.GITHUB_REF_NAME,
		manifest.version,
		"release tag must exactly equal manifest.version (no v prefix)",
	);
}

if (process.argv.includes("--artifacts")) {
	for (const relativePath of ["main.js", "manifest.json", "styles.css"]) {
		await access(path.join(root, relativePath));
		const artifact = await stat(path.join(root, relativePath));
		assert.ok(artifact.isFile(), `${relativePath} must be a file`);
		assert.ok(artifact.size > 0, `${relativePath} must not be empty`);
	}
}

console.log(`release metadata OK — mica ${manifest.version}`);
