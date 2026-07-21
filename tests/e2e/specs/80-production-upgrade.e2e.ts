import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

async function seedAndOpen(path: string, content: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app, obsidian }, filePath, source) => {
			let file = app.vault.getAbstractFileByPath(filePath);
			if (!file) file = await app.vault.create(filePath, source);
			if (!(file instanceof obsidian.TFile)) throw new Error(`not a file: ${filePath}`);
			else await app.vault.modify(file, source);
			await app.workspace.getLeaf(false).openFile(file, { state: { mode: "source", source: false } });
		},
		path,
		content,
	);
}

async function clickLatestMenuItem(title: string): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.executeObsidian(
				(_, expected) =>
					Array.from(document.querySelectorAll<HTMLElement>("body > .menu .menu-item-title")).some(
						(element) => element.textContent?.trim() === expected,
					),
				title,
			),
		{ timeout: 8000, timeoutMsg: `menu item never appeared: ${title}` },
	);
	await browser.executeObsidian((_, expected) => {
		const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).at(-1);
		const item = Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
			(element) => element.querySelector(".menu-item-title")?.textContent?.trim() === expected,
		);
		item?.click();
	}, title);
}

async function closeEditorLightbox(): Promise<void> {
	// Test teardown commits its disposable fixture. Dedicated tests cover dirty
	// discard; saving here avoids coupling this spec to that two-step contract.
	await browser.pause(50);
	await browser.executeObsidian(() => {
		const save = Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-lightbox button")).find(
			(button) => button.textContent?.trim() === "Save",
		);
		save?.click();
	});
	await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector(".mica-lightbox")), {
		timeout: 8000,
		timeoutMsg: "the editor lightbox did not close",
	});
}

describe("production editor, actions, and focused-history upgrade", function () {
	it("shares theme-native gutters and provides bounded full-lightbox search, statistics, and Markdown styling", async function () {
		await seedAndOpen(
			"EditorUpgrade.md",
			"Intro.\n\n```mica id=editor-upgrade\nFirst **bold** and *italic* with ==highlight== and <!-- comment -->.\n\nSecond alpha Alpha alpha.\n```\n",
		);
		const previous = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				settings: { editorLineNumbers: boolean; editorLiveSyntaxStyling: boolean };
				applyStyleVars(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			);
			if (!plugin) throw new Error("Mica is unavailable");
			const old = { ...plugin.settings };
			plugin.settings.editorLineNumbers = false;
			plugin.settings.editorLiveSyntaxStyling = true;
			plugin.applyStyleVars();
			await plugin.saveSettings();
			return old;
		});

		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "the two text regions never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region .mica-md") as HTMLElement | null)?.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-region.is-editing"))),
			{ timeout: 8000, timeoutMsg: "the quick editor never opened" },
		);
		await browser.executeObsidian(() => {
			const trigger = document.querySelector(
				'.mica-lp .mica-region:not(.is-editing) [data-mica-actions~="lightbox"]',
			) as HTMLElement | null;
			trigger?.click();
		});
		await clickLatestMenuItem("Edit source in lightbox");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-mdeditor").length === 2),
			{ timeout: 8000, timeoutMsg: "the quick and full editors were not open together" },
		);

		await browser.executeObsidian(() => {
			document.body.style.setProperty("--mica-gutter-foreground", "rgb(1, 2, 3)");
			(document.querySelector(".mica-lightbox .mica-tool-lines") as HTMLButtonElement | null)?.click();
		});
		const gutterState = await browser.executeObsidian(({ app }) => {
			const hosts = Array.from(document.querySelectorAll<HTMLElement>(".mica-mdeditor"));
			const colors = hosts.map((host) => {
				const gutter = host.shadowRoot?.querySelector(".cm-gutters");
				return gutter ? getComputedStyle(gutter).color : "";
			});
			const quick = document.querySelector<HTMLElement>(".mica-qe-host .mica-mdeditor");
			const quickRoot = quick?.shadowRoot;
			const plugin = (
				app as unknown as {
					plugins: { getPlugin(id: string): { settings: { editorLineNumbers: boolean } } | null };
				}
			).plugins.getPlugin("mica");
			return {
				allNumbered: hosts.every((host) => Boolean(host.shadowRoot?.querySelector(".cm-lineNumbers"))),
				colors,
				persisted: plugin?.settings.editorLineNumbers,
				bold: Boolean(quickRoot?.querySelector(".mica-mstrong")),
				italic: Boolean(quickRoot?.querySelector(".mica-mem")),
				highlight: Boolean(quickRoot?.querySelector(".mica-mhighlight")),
				comment: Boolean(quickRoot?.querySelector(".mica-cc, .mica-mmark")),
			};
		});
		expect(gutterState.allNumbered).toBe(true);
		expect(gutterState.colors).toEqual(["rgb(1, 2, 3)", "rgb(1, 2, 3)"]);
		expect(gutterState.persisted).toBe(true);
		expect(gutterState.bold).toBe(true);
		expect(gutterState.italic).toBe(true);
		expect(gutterState.highlight).toBe(true);
		expect(gutterState.comment).toBe(true);
		const gutterSelection = await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: {
					view: {
						state: { doc: { length: number }; selection: { main: { head: number } } };
						dispatch(spec: unknown): void;
					};
				};
			};
			const view = host.micaEditor?.view;
			view?.dispatch({ selection: { anchor: 0 } });
			const gutter = host.shadowRoot?.querySelector(".cm-gutterElement") as HTMLElement | null;
			gutter?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, cancelable: true }));
			return { head: view?.state.selection.main.head, length: view?.state.doc.length };
		});
		expect(gutterSelection.head).toBe(0);
		expect(gutterSelection.length).toBeGreaterThan(0);

		const commentToggle = await browser.executeObsidian(({ app }) => {
			type Plugin = {
				settings: { editorLiveSyntaxStyling: boolean };
				applyStyleVars(): void;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.editorLiveSyntaxStyling = false;
			plugin.applyStyleVars();
			const host = document.querySelector<HTMLElement>(".mica-qe-host .mica-mdeditor")!;
			const comment = host.shadowRoot?.querySelector(".mica-cc") as HTMLElement | null;
			const state = {
				live: host.shadowRoot?.querySelector(".cm-editor")?.getAttribute("data-mica-live-syntax"),
				italic: comment ? getComputedStyle(comment).fontStyle : "",
			};
			plugin.settings.editorLiveSyntaxStyling = true;
			plugin.applyStyleVars();
			return state;
		});
		expect(commentToggle.live).toBe("off");
		expect(commentToggle.italic).not.toBe("italic");

		await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: {
					setValue(value: string): void;
					view: { dispatch(spec: unknown): void };
				};
			};
			host.micaEditor?.setValue("A callout with **bold** text.\n\n\n");
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelector(".mica-lightbox-stats")?.textContent?.trim() ===
						"5 words · 29 chars · 3 lines",
				),
			{ timeout: 8000, timeoutMsg: "the visible statistics did not match the source contract" },
		);
		await browser.executeObsidian(() => (document.querySelector(".mica-lightbox-stats") as HTMLElement).click());
		const sourceDetails = await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll<HTMLElement>("body > .menu .menu-item-title")).map(
				(element) => element.textContent?.trim() ?? "",
			),
		);
		expect(sourceDetails).toContain("32 UTF-16 units");
		expect(sourceDetails).toContain("4 raw lines");
		await browser.executeObsidian(() => document.body.click());

		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lightbox .mica-editor-menu") as HTMLButtonElement).click();
		});
		await clickLatestMenuItem("Find and replace");
		await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(value: string): void };
			};
			host.micaEditor?.setValue("alpha Alpha alpha");
			const input = document.querySelector(".mica-find-input") as HTMLInputElement;
			input.value = "alpha";
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					/\d+ of 3/.test(document.querySelector(".mica-find-status")?.textContent ?? ""),
				),
			{ timeout: 8000, timeoutMsg: "literal search did not find every match" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector('[aria-label="Show or hide replacement"]') as HTMLButtonElement).click();
			const replacement = document.querySelector(".mica-replace-row .mica-find-input") as HTMLInputElement;
			replacement.value = "WRONG";
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: { getValue(): string; setValue(value: string): void };
			};
			host.micaEditor?.setValue("prefix alpha Alpha alpha");
			const replace = Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-replace-row button")).find(
				(button) => button.textContent?.trim() === "Replace",
			);
			replace?.click();
			if (host.micaEditor?.getValue() !== "prefix alpha Alpha alpha")
				throw new Error("stale replacement remained actionable");
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					/\d+ of 3/.test(document.querySelector(".mica-find-status")?.textContent ?? ""),
				),
			{ timeout: 8000, timeoutMsg: "search did not recover after synchronous stale-result invalidation" },
		);
		await browser.executeObsidian(() => {
			const ribbon = document.querySelector(".mica-find-ribbon") as HTMLElement;
			const regex = Array.from(ribbon.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
				(input) => input.parentElement?.textContent?.includes("Regex"),
			)!;
			regex.click();
			const flags = ribbon.querySelector(".mica-find-flags input") as HTMLInputElement;
			flags.value = "giu";
			flags.dispatchEvent(new InputEvent("input", { bubbles: true }));
			const input = ribbon.querySelector(".mica-find-input") as HTMLInputElement;
			input.value = "(?<word>alpha)";
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					/\d+ of 3/.test(document.querySelector(".mica-find-status")?.textContent ?? ""),
				),
			{ timeout: 8000, timeoutMsg: "named-group regex search did not complete" },
		);
		await browser.executeObsidian(() => {
			const replacement = document.querySelector(".mica-replace-row .mica-find-input") as HTMLInputElement;
			replacement.value = "$<word>!";
			const replaceAll = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".mica-replace-row button"),
			).find((button) => button.textContent?.trim() === "Replace all");
			replaceAll?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
						micaEditor?: { getValue(): string };
					};
					return host.micaEditor?.getValue() === "prefix alpha! Alpha! alpha!";
				}),
			{ timeout: 8000, timeoutMsg: "JavaScript capture replacement did not apply" },
		);
		const mobileLightbox = await browser.executeObsidian(() => {
			if (window.innerWidth > 700) return null;
			const modal = document.querySelector(".mica-lightbox") as HTMLElement;
			const editor = document.querySelector(".mica-lightbox-editor") as HTMLElement;
			const rect = editor.getBoundingClientRect();
			return {
				modalWidth: modal.getBoundingClientRect().width,
				editorWidth: rect.width,
				withinViewport: rect.left >= 0 && rect.right <= window.innerWidth,
				findWrap: getComputedStyle(document.querySelector(".mica-find-row")!).flexWrap,
			};
		});
		if (mobileLightbox) {
			expect(mobileLightbox.modalWidth).toBeLessThanOrEqual(700);
			expect(mobileLightbox.editorWidth).toBeGreaterThan(280);
			expect(mobileLightbox.withinViewport).toBe(true);
			expect(mobileLightbox.findWrap).toBe("wrap");
		}
		await browser.executeObsidian(() => {
			const ribbon = document.querySelector(".mica-find-ribbon") as HTMLElement;
			const input = ribbon.querySelector(".mica-find-input") as HTMLInputElement;
			input.value = "(?=a)";
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const status = document.querySelector(".mica-find-status")?.textContent?.trim() ?? "";
					return Boolean(status && status !== "Searching…");
				}),
			{ timeout: 8000, timeoutMsg: "zero-width search did not settle" },
		);
		const zeroWidthStatus = await browser.executeObsidian(
			() => document.querySelector(".mica-find-status")?.textContent?.trim() ?? "",
		);
		expect(zeroWidthStatus).toMatch(/\d+ of 6/);
		await browser.executeObsidian(() => {
			const flags = document.querySelector(".mica-find-flags input") as HTMLInputElement;
			flags.value = "zz";
			flags.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const status = document.querySelector(".mica-find-status")?.textContent ?? "";
					return status !== "Searching…" && /flag|invalid|duplicate/i.test(status);
				}),
			{ timeout: 8000, timeoutMsg: "invalid regex flags did not report inline" },
		);
		await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(value: string): void };
			};
			host.micaEditor?.setValue(`${"a".repeat(12_000)}!`);
			const flags = document.querySelector(".mica-find-flags input") as HTMLInputElement;
			flags.value = "";
			flags.dispatchEvent(new InputEvent("input", { bubbles: true }));
			const input = document.querySelector(".mica-find-input") as HTMLInputElement;
			input.value = "^(a+)+$";
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelector(".mica-find-status")?.textContent?.trim() === "Pattern took too long",
				),
			{ timeout: 8000, timeoutMsg: "pathological regex was not cancelled" },
		);
		await browser.executeObsidian(() => {
			const regex = Array.from(
				document.querySelectorAll<HTMLInputElement>('.mica-find-option input[type="checkbox"]'),
			).find((input) => input.parentElement?.textContent?.includes("Regex"))!;
			regex.click();
			const input = document.querySelector(".mica-find-input") as HTMLInputElement;
			input.value = "!";
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					/1 of 1/.test(document.querySelector(".mica-find-status")?.textContent ?? ""),
				),
			{ timeout: 8000, timeoutMsg: "the search worker did not recover after cancellation" },
		);
		await browser.executeObsidian(() => (document.querySelector(".mica-find-input") as HTMLInputElement).focus());
		await browser.keys([Key.Escape]);
		expect(
			await browser.executeObsidian(() => ({
				searchHidden: (document.querySelector(".mica-find-ribbon") as HTMLElement).hidden,
				modalOpen: Boolean(document.querySelector(".mica-lightbox")),
			})),
		).toEqual({ searchHidden: true, modalOpen: true });

		await closeEditorLightbox();
		await browser.executeObsidian(async ({ app }, old) => {
			type Plugin = {
				settings: { editorLineNumbers: boolean; editorLiveSyntaxStyling: boolean };
				applyStyleVars(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			);
			if (!plugin) return;
			plugin.settings.editorLineNumbers = old.editorLineNumbers;
			plugin.settings.editorLiveSyntaxStyling = old.editorLiveSyntaxStyling;
			plugin.applyStyleVars();
			await plugin.saveSettings();
			document.body.style.removeProperty("--mica-gutter-foreground");
			(document.querySelector(".mica-lp .mica-qe-cancel") as HTMLButtonElement | null)?.click();
		}, previous);
	});

	it("keeps code toolbars scoped and repaints custom buttons without replacing the editor", async function () {
		await seedAndOpen(
			"CodeToolbarUpgrade.md",
			"Intro.\n\n````mica id=code-toolbar-upgrade\n```\nconst value = 1;\n```\n````\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector('[data-mica-actions~="fields"]'))),
			{ timeout: 8000, timeoutMsg: "the code actions never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector('[data-mica-actions~="fields"]') as HTMLButtonElement).click();
		});
		await clickLatestMenuItem("Edit language and code…");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lightbox .mica-codeedit-info"))),
			{ timeout: 8000, timeoutMsg: "the code lightbox never opened" },
		);

		const previous = await browser.executeObsidian(async ({ app }) => {
			type Tool = {
				id: string;
				name: string;
				icon: string;
				template: string;
				surface?: "markdown" | "code" | "both";
			};
			type Plugin = {
				settings: { toolbarLayout: string[]; customTools: Tool[] };
				applyToolbarConfig(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			);
			if (!plugin) throw new Error("Mica is unavailable");
			const old = {
				layout: [...plugin.settings.toolbarLayout],
				customs: plugin.settings.customTools.map((tool) => ({ ...tool })),
			};
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement;
			host.dataset.testIdentity = "same-editor";
			plugin.settings.customTools = [
				...plugin.settings.customTools.filter((tool) => tool.id !== "e2e-code-probe"),
				{
					id: "e2e-code-probe",
					name: "Code probe",
					icon: "sparkles",
					template: "PROBE{cursor}",
					surface: "code",
				},
			];
			plugin.settings.toolbarLayout = ["custom:e2e-code-probe", ...plugin.settings.toolbarLayout];
			plugin.applyToolbarConfig();
			await plugin.saveSettings();
			return old;
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector('.mica-lightbox .mica-toolbar [aria-label="Code probe"]')),
				),
			{ timeout: 8000, timeoutMsg: "the code-scoped custom button did not appear live" },
		);
		const initialChrome = await browser.executeObsidian(() => ({
			identity: document.querySelector(".mica-lightbox .mica-mdeditor")?.getAttribute("data-test-identity"),
			plain: document.querySelector(".mica-codeedit-status")?.textContent?.trim(),
			boldBuiltin: Boolean(document.querySelector('.mica-lightbox .mica-toolbar [aria-label="Bold"]')),
			buttonTabIndex: (
				document.querySelector('.mica-lightbox .mica-toolbar [aria-label="Code probe"]') as HTMLElement
			).tabIndex,
		}));
		expect(initialChrome).toEqual({
			identity: "same-editor",
			plain: "Plain text",
			boldBuiltin: false,
			buttonTabIndex: 0,
		});
		await browser.executeObsidian(() => (document.querySelector(".mica-editor-menu") as HTMLButtonElement).click());
		const plainSyntaxDisabled = await browser.executeObsidian(() => {
			const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).at(-1);
			const item = Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
				(row) => row.querySelector(".menu-item-title")?.textContent?.trim() === "Style Markdown source",
			);
			return item?.hasClass("is-disabled") ?? false;
		});
		expect(plainSyntaxDisabled).toBe(true);
		await browser.executeObsidian(() => document.body.click());
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector("body > .menu")), {
			timeout: 8000,
			timeoutMsg: "the plain-code editor menu did not dismiss",
		});
		await browser.executeObsidian(({ app }) => {
			type Plugin = {
				settings: { customTools: { id: string; surface?: "markdown" | "code" | "both" }[] };
				applyToolbarConfig(): void;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			const probe = plugin.settings.customTools.find((tool) => tool.id === "e2e-code-probe")!;
			probe.surface = "markdown";
			plugin.applyToolbarConfig();
		});
		expect(
			await browser.executeObsidian(() => ({
				button: Boolean(document.querySelector('.mica-lightbox .mica-toolbar [aria-label="Code probe"]')),
				identity: document.querySelector(".mica-lightbox .mica-mdeditor")?.getAttribute("data-test-identity"),
			})),
		).toEqual({ button: false, identity: "same-editor" });
		await browser.executeObsidian(({ app }) => {
			type Plugin = {
				settings: { customTools: { id: string; surface?: "markdown" | "code" | "both" }[] };
				applyToolbarConfig(): void;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			plugin.settings.customTools.find((tool) => tool.id === "e2e-code-probe")!.surface = "both";
			plugin.applyToolbarConfig();
			const info = document.querySelector(".mica-codeedit-info") as HTMLInputElement;
			info.value = "markdown";
			info.dispatchEvent(new InputEvent("input", { bubbles: true }));
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(value: string): void };
			};
			host.micaEditor?.setValue("**bold**");
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const host = document.querySelector<HTMLElement>(".mica-lightbox .mica-mdeditor");
					return (
						document.querySelector(".mica-codeedit-status")?.textContent?.trim() === "markdown" &&
						Boolean(host?.shadowRoot?.querySelector(".mica-mstrong")) &&
						Boolean(document.querySelector('.mica-lightbox .mica-toolbar [aria-label="Code probe"]'))
					);
				}),
			{ timeout: 8000, timeoutMsg: "the Markdown code mode or live toolbar scope did not update" },
		);
		await browser.executeObsidian(() => (document.querySelector(".mica-editor-menu") as HTMLButtonElement).click());
		const markdownSyntaxDisabled = await browser.executeObsidian(() => {
			const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).at(-1);
			const item = Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
				(row) => row.querySelector(".menu-item-title")?.textContent?.trim() === "Style Markdown source",
			);
			return item?.hasClass("is-disabled") ?? false;
		});
		expect(markdownSyntaxDisabled).toBe(false);
		await browser.executeObsidian(() => document.body.click());
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector("body > .menu")), {
			timeout: 8000,
			timeoutMsg: "the Markdown-code editor menu did not dismiss",
		});
		await browser.executeObsidian(() => (document.querySelector(".mica-editor-menu") as HTMLElement).focus());
		await browser.keys([Key.Enter]);
		await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector("body > .menu"))), {
			timeout: 8000,
			timeoutMsg: "keyboard activation did not open the editor action menu",
		});
		await browser.keys([Key.Escape]);
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector("body > .menu")), {
			timeout: 8000,
			timeoutMsg: "Escape did not dismiss the editor action menu",
		});
		expect(await browser.executeObsidian(() => Boolean(document.querySelector(".mica-lightbox")))).toBe(true);

		await closeEditorLightbox();
		await browser.executeObsidian(async ({ app }, old) => {
			type Tool = {
				id: string;
				name: string;
				icon: string;
				template: string;
				surface?: "markdown" | "code" | "both";
			};
			type Plugin = {
				settings: { toolbarLayout: string[]; customTools: Tool[] };
				applyToolbarConfig(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			);
			if (!plugin) return;
			plugin.settings.toolbarLayout = old.layout;
			plugin.settings.customTools = old.customs;
			plugin.applyToolbarConfig();
			await plugin.saveSettings();
		}, previous);
	});

	it("opens action menus accessibly and disables hover-open for coarse pointers", async function () {
		await seedAndOpen("ActionMenuUpgrade.md", "Intro.\n\n```mica id=action-upgrade\nmenu body\n```\n");
		const previous = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				settings: { actionMenuTrigger: "click" | "hover" };
				applyStyleVars(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			const old = plugin.settings.actionMenuTrigger;
			plugin.settings.actionMenuTrigger = "hover";
			plugin.applyStyleVars();
			await plugin.saveSettings();
			return old;
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp [data-mica-actions]"))),
			{ timeout: 8000, timeoutMsg: "the action trigger never rendered" },
		);
		const coarseTarget = await browser.executeObsidian(() => {
			if (!window.matchMedia("(pointer: coarse)").matches) return null;
			const trigger = document.querySelector(".mica-lp [data-mica-actions]") as HTMLElement;
			const rect = trigger.getBoundingClientRect();
			const style = getComputedStyle(trigger);
			return {
				width: rect.width,
				height: rect.height,
				opacity: style.opacity,
				pointerEvents: style.pointerEvents,
			};
		});
		if (coarseTarget) {
			expect(coarseTarget.width).toBeGreaterThanOrEqual(40);
			expect(coarseTarget.height).toBeGreaterThanOrEqual(40);
			expect(coarseTarget.opacity).toBe("1");
			expect(coarseTarget.pointerEvents).not.toBe("none");
		}
		await browser.executeObsidian(() => {
			const trigger = document.querySelector(".mica-lp [data-mica-actions]") as HTMLElement;
			trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
		});
		if (coarseTarget) {
			await browser.pause(450);
			expect(await browser.executeObsidian(() => Boolean(document.querySelector("body > .menu")))).toBe(false);
		} else {
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector("body > .menu"))),
				{ timeout: 8000, timeoutMsg: "fine-pointer hover did not open the menu after its delay" },
			);
			await browser.executeObsidian(() => document.body.click());
			await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector("body > .menu")), {
				timeout: 8000,
				timeoutMsg: "the hover menu did not dismiss",
			});
			await browser.executeObsidian(() => {
				const nativeMatch = window.matchMedia.bind(window);
				(window as unknown as { __micaMatchMedia?: typeof window.matchMedia }).__micaMatchMedia =
					window.matchMedia;
				window.matchMedia = ((query: string) =>
					query === "(hover: hover) and (pointer: fine)"
						? ({ matches: false, media: query } as MediaQueryList)
						: nativeMatch(query)) as typeof window.matchMedia;
				const trigger = document.querySelector(".mica-lp [data-mica-actions]") as HTMLElement;
				trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
			});
			await browser.pause(450);
			expect(await browser.executeObsidian(() => Boolean(document.querySelector("body > .menu")))).toBe(false);
			await browser.executeObsidian(() => {
				const holder = window as unknown as { __micaMatchMedia?: typeof window.matchMedia };
				if (holder.__micaMatchMedia) window.matchMedia = holder.__micaMatchMedia;
				delete holder.__micaMatchMedia;
			});
		}
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp [data-mica-actions]") as HTMLElement).focus();
		});
		await browser.keys([Key.Enter]);
		await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector("body > .menu"))), {
			timeout: 8000,
			timeoutMsg: "Enter did not open the focused action menu",
		});
		await browser.keys([Key.Escape]);
		await browser.executeObsidian(async ({ app }, old) => {
			type Plugin = {
				settings: { actionMenuTrigger: "click" | "hover" };
				applyStyleVars(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			plugin.settings.actionMenuTrigger = old;
			plugin.applyStyleVars();
			await plugin.saveSettings();
		}, previous);
	});

	it("builds many section action menus without document-wide region scans", async function () {
		await browser.executeObsidian(() => {
			type Holder = Window & {
				__micaOriginalElementQuery?: typeof Element.prototype.querySelectorAll;
				__micaRegionQueryCount?: number;
			};
			const holder = window as Holder;
			const original = Element.prototype.querySelectorAll;
			holder.__micaOriginalElementQuery = original;
			holder.__micaRegionQueryCount = 0;
			Element.prototype.querySelectorAll = function (selectors: string) {
				if (selectors === ".mica-region") holder.__micaRegionQueryCount! += 1;
				return original.call(this, selectors);
			} as typeof Element.prototype.querySelectorAll;
		});
		try {
			const body = Array.from({ length: 240 }, (_, index) => `:::section\nSection ${index}\n:::\n`).join("");
			await seedAndOpen("LinearSectionMenus.md", `Intro.\n\n\`\`\`mica id=linear-sections\n${body}\`\`\`\n`);
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() => document.querySelectorAll(".mica-lp .mica-region [data-mica-actions]").length >= 240,
					),
				{ timeout: 12000, timeoutMsg: "the large section fixture did not render every action menu" },
			);
			const scans = await browser.executeObsidian(
				() => (window as Window & { __micaRegionQueryCount?: number }).__micaRegionQueryCount ?? 0,
			);
			expect(scans).toBeLessThan(5);
		} finally {
			await browser.executeObsidian(() => {
				type Holder = Window & {
					__micaOriginalElementQuery?: typeof Element.prototype.querySelectorAll;
					__micaRegionQueryCount?: number;
				};
				const holder = window as Holder;
				if (holder.__micaOriginalElementQuery)
					Element.prototype.querySelectorAll = holder.__micaOriginalElementQuery;
				delete holder.__micaOriginalElementQuery;
				delete holder.__micaRegionQueryCount;
			});
		}
	});

	it("renders exact timestamps live and requires an explicit match for ambiguous focused history", async function () {
		const note = "FocusedHistoryUpgrade.md";
		const id = "focused-history-upgrade";
		const before = [
			":::tabs",
			":::tab Main",
			"```js",
			"const duplicate = 1;",
			"```",
			"",
			"```js",
			"const duplicate = 1;",
			"```",
			":::",
			":::",
			"",
		].join("\n");
		const after = [
			":::tabs",
			":::tab Main",
			"[outside](https://example.com)",
			"",
			"```js",
			"const duplicate = 2;",
			"```",
			":::",
			":::",
			"",
		].join("\n");
		await seedAndOpen(note, `Intro.\n\n\`\`\`\`mica id=${id}\n${before}\`\`\`\`\n`);
		await browser.executeObsidian((_, path) => window.mica.versionsSnapshot(path), note);
		await browser.executeObsidian(
			(_, path, blockId, body) => window.mica.blockUpdate(path, blockId, body),
			note,
			id,
			after,
		);
		await browser.executeObsidian((_, path) => window.mica.versionsSnapshot(path), note);
		const previousExact = await browser.executeObsidian(({ app }) => {
			type Plugin = { settings: { showVersionExactTimestamps: boolean }; applyStyleVars(): void };
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			const old = plugin.settings.showVersionExactTimestamps;
			plugin.settings.showVersionExactTimestamps = false;
			plugin.applyStyleVars();
			return old;
		});
		await browser.executeObsidianCommand("mica:diff-versions");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-versions-modal time").length >= 2),
			{ timeout: 8000, timeoutMsg: "the history timeline never opened" },
		);
		const mobileHistory = await browser.executeObsidian(() => {
			if (window.innerWidth > 700) return null;
			const root = document.querySelector(".mica-versions-root") as HTMLElement;
			const main = document.querySelector(".mica-versions-main") as HTMLElement;
			const rect = main.getBoundingClientRect();
			return {
				direction: getComputedStyle(root).flexDirection,
				mainWidth: rect.width,
				withinViewport: rect.left >= 0 && rect.right <= window.innerWidth,
			};
		});
		if (mobileHistory) {
			expect(mobileHistory.direction).toBe("column");
			expect(mobileHistory.mainWidth).toBeGreaterThan(280);
			expect(mobileHistory.withinViewport).toBe(true);
		}
		const relative = await browser.executeObsidian(
			() => document.querySelector(".mica-versions-modal time")?.textContent?.trim() ?? "",
		);
		await browser.executeObsidian(({ app }) => {
			type Plugin = { settings: { showVersionExactTimestamps: boolean }; applyStyleVars(): void };
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			plugin.settings.showVersionExactTimestamps = true;
			plugin.applyStyleVars();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					(_, oldText) =>
						(document.querySelector(".mica-versions-modal time")?.textContent?.trim() ?? "") !== oldText,
					relative,
				),
			{ timeout: 8000, timeoutMsg: "exact timestamps did not update in the open modal" },
		);
		const semanticTime = await browser.executeObsidian(() => {
			const time = document.querySelector(".mica-versions-modal time") as HTMLTimeElement;
			return { text: time.textContent ?? "", datetime: time.dateTime, title: time.title };
		});
		expect(semanticTime.text).toContain(" · ");
		expect(semanticTime.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(semanticTime.title).toContain("Z · ");

		await browser.executeObsidian(() => {
			const inspect = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".mica-versions-toolbar button"),
			).find((button) => button.textContent?.trim() === "Inspect");
			inspect?.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-inspector-render"))),
			{ timeout: 8000, timeoutMsg: "the rendered inspector never appeared" },
		);
		const inspectorChrome = await browser.executeObsidian(() => ({
			scopes: document.querySelectorAll(".mica-inspector-render [data-mica-inspect-key]").length,
			codeScopes: document.querySelectorAll('.mica-inspector-render [data-mica-inspect-key^="code:"]').length,
			menus: document.querySelectorAll(".mica-inspector-render .mica-entity-menu").length,
			drags: document.querySelectorAll(".mica-inspector-render .mica-region-grip").length,
		}));
		expect(inspectorChrome.scopes).toBeGreaterThan(3);
		expect(inspectorChrome.codeScopes).toBe(1);
		expect(inspectorChrome.menus).toBe(0);
		expect(inspectorChrome.drags).toBe(0);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const link = document.querySelector(".mica-inspector-render a") as HTMLAnchorElement | null;
					return link?.tabIndex === -1 && link.getAttribute("aria-disabled") === "true";
				}),
			{ timeout: 8000, timeoutMsg: "inspector links remained externally navigable" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector('.mica-inspector-render [data-mica-inspect-key^="code:"]') as HTMLElement).focus();
		});
		await browser.keys([Key.Enter]);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector(".mica-inspector-breadcrumb button.is-current")),
				),
			{ timeout: 8000, timeoutMsg: "the selected scope did not pin or expose its breadcrumb" },
		);
		await browser.executeObsidian(() => {
			const compare = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".mica-inspector-footer button"),
			).find((button) => button.textContent?.trim() === "Compare selected");
			compare?.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-scope-picker"))),
			{ timeout: 8000, timeoutMsg: "an ambiguous same-label scope was silently matched by path" },
		);
		expect(await browser.executeObsidian(() => document.querySelectorAll(".mica-scope-candidate").length)).toBe(2);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-scope-candidate") as HTMLButtonElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const caption =
						document.querySelector(".mica-versions-surface .mica-diff-caption")?.textContent ?? "";
					return caption.includes("Block") && caption.includes("js");
				}),
			{ timeout: 8000, timeoutMsg: "manual counterpart selection did not produce a focused diff" },
		);
		await browser.executeObsidian(async ({ app }, old) => {
			type Plugin = {
				settings: { showVersionExactTimestamps: boolean };
				applyStyleVars(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			plugin.settings.showVersionExactTimestamps = old;
			plugin.applyStyleVars();
			await plugin.saveSettings();
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement | null)?.click();
		}, previousExact);
	});
});
