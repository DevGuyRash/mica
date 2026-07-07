import * as path from "node:path";

/**
 * E2E harness: wdio-obsidian-service downloads a sandboxed Obsidian, installs
 * the built plugin (manifest.json + main.js + styles.css from the repo root),
 * and opens a throwaway copy of tests/e2e/vault. Specs assert plugin-owned
 * contracts (window.mica results, file contents, our own class names) — never
 * Obsidian's internal DOM.
 */
export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./tests/e2e/specs/**/*.e2e.ts"],
	maxInstances: 1,
	capabilities: [
		{
			browserName: "obsidian",
			browserVersion: "latest",
			"wdio:obsidianOptions": {
				installerVersion: "earliest",
				plugins: ["."],
				vault: "tests/e2e/vault",
			},
		},
	],
	services: ["obsidian"],
	reporters: ["obsidian"],
	cacheDir: path.resolve(".obsidian-cache"),
	waitforTimeout: 10_000,
	mochaOpts: {
		ui: "bdd",
		timeout: 120_000,
	},
	logLevel: "warn",
};
