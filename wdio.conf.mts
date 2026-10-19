import * as path from "node:path";

type E2eProfile = "default" | "minimum" | "mobile" | "desktop-latest";

// Minimum-version qualification target; a target is not evidence of a completed run.
const MINIMUM_APP_VERSION = "1.13.0";
// Oldest compatible installer in the pinned launcher-index evidence documented
// in RELEASING.md. This pin is a target, not evidence of a native test pass.
const PINNED_INSTALLER_VERSION = "1.6.5";

const requestedProfile = process.env.MICA_E2E_PROFILE ?? "default";
if (!(["default", "minimum", "mobile", "desktop-latest"] as const).includes(requestedProfile as E2eProfile)) {
	throw new Error(
		`unknown MICA_E2E_PROFILE=${requestedProfile}; expected default, minimum, mobile, or desktop-latest`,
	);
}
const profile = requestedProfile as E2eProfile;

function capabilityFor(selected: E2eProfile): WebdriverIO.Capabilities {
	const latest = selected === "desktop-latest";
	const mobile = selected === "mobile";
	return {
		browserName: "obsidian",
		browserVersion: latest ? "latest" : MINIMUM_APP_VERSION,
		"wdio:obsidianOptions": {
			...(mobile ? { emulateMobile: true } : {}),
			installerVersion: latest ? "latest" : PINNED_INSTALLER_VERSION,
			plugins: ["."],
			vault: "tests/e2e/vault",
		},
		...(mobile
			? {
					"goog:chromeOptions": {
						mobileEmulation: {
							deviceMetrics: { width: 390, height: 844, pixelRatio: 3 },
						},
					},
				}
			: {}),
	};
}

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
	capabilities: [capabilityFor(profile)],
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
