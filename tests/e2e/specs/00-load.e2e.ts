import { browser, expect } from "@wdio/globals";

describe("plugin load", function () {
	it("activates Mica and exposes the window.mica API", async function () {
		const info = await browser.executeObsidian(({ app }) => {
			const plugins = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins;
			return {
				active: "mica" in plugins,
				version: typeof window.mica?.version === "function" ? window.mica.version() : null,
			};
		});
		expect(info.active).toBe(true);
		expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
