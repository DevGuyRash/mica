import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { clickLatestMenuItem, seedAndOpenNote } from "../helpers";

async function seedAndOpen(path: string, content: string): Promise<void> {
	await seedAndOpenNote(path, content, { overwriteExisting: true });
}

async function activateEditorAction(label: string): Promise<void> {
	const openedMenu = await browser.executeObsidian((_, expected) => {
		const direct = Array.from(
			document.querySelectorAll<HTMLButtonElement>(`.mica-lightbox-toolbar button[aria-label="${expected}"]`),
		).find((button) => !button.hasClass("mica-editor-menu") && getComputedStyle(button).display !== "none");
		if (direct) {
			direct.click();
			return false;
		}
		(document.querySelector(".mica-lightbox .mica-editor-menu") as HTMLButtonElement).click();
		return true;
	}, label);
	if (openedMenu) await clickLatestMenuItem(label);
}

async function activateEntityAction(rootSelector: string, actionId: string, label: string): Promise<void> {
	const openedMenu = await browser.executeObsidian(
		(_, selector, id) => {
			const root = document.querySelector<HTMLElement>(selector);
			const direct = root?.querySelector<HTMLButtonElement>(`[data-mica-action="${id}"]`);
			if (direct && getComputedStyle(direct).display !== "none") {
				direct.click();
				return false;
			}
			root?.querySelector<HTMLButtonElement>('[data-mica-responsive-role="overflow"]')?.click();
			return true;
		},
		rootSelector,
		actionId,
	);
	if (openedMenu) await clickLatestMenuItem(label);
}

async function editorActionDisabled(label: string): Promise<boolean> {
	const direct = await browser.executeObsidian((_, expected) => {
		const button = Array.from(
			document.querySelectorAll<HTMLButtonElement>(`.mica-lightbox-toolbar button[aria-label="${expected}"]`),
		).find(
			(candidate) => !candidate.hasClass("mica-editor-menu") && getComputedStyle(candidate).display !== "none",
		);
		return button ? button.disabled : null;
	}, label);
	if (direct !== null) return direct;
	await browser.executeObsidian(() => (document.querySelector(".mica-editor-menu") as HTMLButtonElement).click());
	await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector("body > .menu"))), {
		timeout: 8000,
		timeoutMsg: `editor action menu did not open for ${label}`,
	});
	return browser.executeObsidian((_, expected) => {
		const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).at(-1);
		const item = Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
			(row) => row.querySelector(".menu-item-title")?.textContent?.trim() === expected,
		);
		return item?.hasClass("is-disabled") ?? false;
	}, label);
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
		await activateEntityAction(
			".mica-lp .mica-region:not(.is-editing) .mica-region-tools",
			"lightbox",
			"Edit source in lightbox",
		);
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

		await activateEditorAction("Find and replace");
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
			{ timeout: 15_000, timeoutMsg: "literal search did not find every match" },
		);
		const searchDefaults = await browser.executeObsidian(() => {
			const labels = Array.from(document.querySelectorAll<HTMLLabelElement>(".mica-find-options label"));
			const checked = (name: string) =>
				labels
					.find((label) => label.textContent?.includes(name))
					?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false;
			return { global: checked("Global"), multiline: checked("Multiline") };
		});
		expect(searchDefaults).toEqual({ global: true, multiline: true });
		await browser.executeObsidian(() => {
			(document.querySelector('[aria-label="Toggle replacement controls"]') as HTMLButtonElement).click();
			const replacement = document.querySelector(".mica-replace-row .mica-find-input") as HTMLInputElement;
			replacement.value = "WRONG";
			replacement.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					/\d+ of 3/.test(document.querySelector(".mica-find-status")?.textContent ?? ""),
				),
			{ timeout: 8000, timeoutMsg: "replacement preview scan did not settle" },
		);
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-replace-preview-controls button"))
				.find((button) => button.textContent === "Changes")
				?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
						micaEditor?: { getValue(): string };
					};
					return Boolean(
						host.shadowRoot?.querySelector(".mica-search-preview-old") &&
						host.shadowRoot?.querySelector(".mica-search-preview-new") &&
						host.micaEditor?.getValue() === "alpha Alpha alpha",
					);
				}),
			{ timeout: 8000, timeoutMsg: "non-mutating Changes preview did not render" },
		);
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-replace-preview-controls button"))
				.find((button) => button.textContent === "Result")
				?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
						micaEditor?: { getValue(): string };
					};
					return Boolean(
						host.shadowRoot?.querySelector(".mica-search-preview-result") &&
						host.micaEditor?.getValue() === "alpha Alpha alpha",
					);
				}),
			{ timeout: 8000, timeoutMsg: "non-mutating Result preview did not render" },
		);
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-replace-preview-controls button"))
				.find((button) => button.textContent === "Original")
				?.click();
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
			const global = Array.from(document.querySelectorAll<HTMLLabelElement>(".mica-find-options label"))
				.find((label) => label.textContent?.includes("Global"))
				?.querySelector<HTMLInputElement>('input[type="checkbox"]');
			global?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const status = document.querySelector(".mica-find-status")?.textContent ?? "";
					const replaceAll = Array.from(
						document.querySelectorAll<HTMLButtonElement>(".mica-replace-row button"),
					).find((button) => button.textContent === "Replace all");
					return /1 of 1/.test(status) && replaceAll?.disabled === true;
				}),
			{ timeout: 8000, timeoutMsg: "Global-off first-match behavior did not settle" },
		);
		await browser.executeObsidian(() => {
			const global = Array.from(document.querySelectorAll<HTMLLabelElement>(".mica-find-options label"))
				.find((label) => label.textContent?.includes("Global"))
				?.querySelector<HTMLInputElement>('input[type="checkbox"]');
			global?.click();
		});
		await browser.executeObsidian(() => {
			const ribbon = document.querySelector(".mica-find-ribbon") as HTMLElement;
			const regex = Array.from(ribbon.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
				(input) => input.parentElement?.textContent?.includes("Regex"),
			)!;
			regex.click();
			const flags = ribbon.querySelector(".mica-find-flags input") as HTMLInputElement;
			flags.value = "u";
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
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector('[data-mica-action="fields"], [data-mica-actions~="fields"]')),
				),
			{ timeout: 8000, timeoutMsg: "the code actions never rendered" },
		);
		await activateEntityAction(
			'.mica-lp .mica-responsive-actions[data-mica-action-strip~="fields"]',
			"fields",
			"Edit language and code…",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lightbox .mica-codeedit-info"))),
			{ timeout: 8000, timeoutMsg: "the code lightbox never opened" },
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const search = document.querySelector<HTMLElement>(
						'.mica-lightbox-toolbar [aria-label="Find and replace"]',
					);
					return Boolean(search && getComputedStyle(search).display !== "none");
				}),
			{ timeout: 8000, timeoutMsg: "wide code-lightbox actions did not promote into the toolbar" },
		);
		const wideToolbar = await browser.executeObsidian(() => {
			const toolbar = document.querySelector<HTMLElement>(".mica-lightbox-toolbar")!;
			const visible = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).filter(
				(button) => getComputedStyle(button).display !== "none",
			);
			return {
				lineNumbersVisible:
					getComputedStyle(toolbar.querySelector<HTMLElement>(".mica-tool-lines")!).display !== "none",
				buttons: visible
					.filter((button) => button.querySelector("svg"))
					.map((button) => ({
						label: button.getAttribute("aria-label"),
						width: button.getBoundingClientRect().width,
						svgWidth: button.querySelector("svg")?.getBoundingClientRect().width ?? 0,
					})),
			};
		});
		expect(wideToolbar.lineNumbersVisible).toBe(true);
		expect(wideToolbar.buttons.every((button) => button.width >= 22 && button.svgWidth >= 12)).toBe(true);
		await browser.executeObsidian(() => {
			document.querySelector<HTMLElement>(".mica-lightbox-toolbar")!.style.maxWidth = "78px";
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const menu = document.querySelector<HTMLElement>(".mica-editor-menu");
					const search = document.querySelector<HTMLElement>(
						'.mica-lightbox-toolbar [aria-label="Find and replace"]',
					);
					return Boolean(
						menu &&
						getComputedStyle(menu).display !== "none" &&
						search &&
						getComputedStyle(search).display === "none",
					);
				}),
			{ timeout: 8000, timeoutMsg: "narrow code-lightbox actions did not collapse into the ellipsis" },
		);
		await browser.executeObsidian(() => {
			document.querySelector<HTMLElement>(".mica-lightbox-toolbar")!.style.maxWidth = "";
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const search = document.querySelector<HTMLElement>(
						'.mica-lightbox-toolbar [aria-label="Find and replace"]',
					);
					return Boolean(search && getComputedStyle(search).display !== "none");
				}),
			{ timeout: 8000, timeoutMsg: "code-lightbox actions did not promote again after widening" },
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
		const plainSyntaxDisabled = await editorActionDisabled("Style Markdown source");
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
		const markdownSyntaxDisabled = await editorActionDisabled("Style Markdown source");
		expect(markdownSyntaxDisabled).toBe(false);
		await browser.executeObsidian(() => document.body.click());
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector("body > .menu")), {
			timeout: 8000,
			timeoutMsg: "the Markdown-code editor menu did not dismiss",
		});
		await browser.executeObsidian(() => {
			const toolbar = document.querySelector<HTMLElement>(".mica-lightbox-toolbar")!;
			toolbar.style.maxWidth = "150px";
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const button = document.querySelector<HTMLElement>(".mica-editor-menu");
					return Boolean(button && getComputedStyle(button).display !== "none");
				}),
			{ timeout: 8000, timeoutMsg: "editor actions did not collapse into the narrow-toolbar menu" },
		);
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
				settings: {
					actionMenuTrigger: "click" | "hover";
					entityActionLayout: "responsive" | "menu-only";
				};
				applyStyleVars(): void;
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			const old = {
				actionMenuTrigger: plugin.settings.actionMenuTrigger,
				entityActionLayout: plugin.settings.entityActionLayout,
			};
			plugin.settings.actionMenuTrigger = "hover";
			plugin.settings.entityActionLayout = "responsive";
			plugin.applyStyleVars();
			plugin.refreshViews();
			await plugin.saveSettings();
			return old;
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp [data-mica-actions]"))),
			{ timeout: 8000, timeoutMsg: "the action trigger never rendered" },
		);
		// Make the packing boundary deterministic even under the 390px mobile
		// profile: this assertion is specifically the wide-container contract.
		await browser.executeObsidian(() => {
			const region = document.querySelector<HTMLElement>(".mica-lp .mica-region");
			if (region) region.style.width = "900px";
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Array.from(document.querySelectorAll<HTMLElement>('.mica-lp [data-mica-action^="copy-"]')).some(
						(button) => getComputedStyle(button).display !== "none",
					),
				),
			{ timeout: 8000, timeoutMsg: "responsive entity actions never promoted copy into the hover strip" },
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const strip = document.querySelector<HTMLElement>(
						".mica-lp .mica-region-tools .mica-responsive-actions",
					);
					const more = strip?.querySelector<HTMLElement>('[data-mica-responsive-role="overflow"]');
					const actionCount = (strip?.dataset.micaActionStrip ?? "").split(" ").filter(Boolean).length;
					const directCount = Array.from(
						strip?.querySelectorAll<HTMLElement>("[data-mica-action]") ?? [],
					).filter((button) => getComputedStyle(button).display !== "none").length;
					return Boolean(
						strip &&
						more &&
						getComputedStyle(more).display === "none" &&
						actionCount > 0 &&
						directCount === actionCount,
					);
				}),
			{
				timeout: 8000,
				timeoutMsg: "wide responsive actions kept an unnecessary ellipsis or hid an action",
			},
		);
		await browser.executeObsidian(() => {
			const region = document.querySelector<HTMLElement>(".mica-lp .mica-region");
			if (region) region.style.width = "132px";
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Array.from(
						document.querySelectorAll<HTMLElement>('.mica-lp [data-mica-responsive-role="overflow"]'),
					).some((button) => getComputedStyle(button).display !== "none"),
				),
			{ timeout: 8000, timeoutMsg: "narrow responsive actions did not create an ellipsis" },
		);
		await browser.executeObsidian(({ app }) => {
			type Plugin = {
				settings: { entityActionLayout: "responsive" | "menu-only" };
				refreshViews(): void;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.entityActionLayout = "menu-only";
			plugin.refreshViews();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Array.from(
						document.querySelectorAll<HTMLElement>(".mica-lp .mica-entity-strip [data-mica-action]"),
					).every((button) => getComputedStyle(button).display === "none"),
				),
			{ timeout: 8000, timeoutMsg: "menu-only mode left a secondary entity action visible" },
		);
		await browser.executeObsidian(({ app }) => {
			type Plugin = {
				settings: { entityActionLayout: "responsive" | "menu-only" };
				refreshViews(): void;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.entityActionLayout = "responsive";
			plugin.refreshViews();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp [data-mica-actions]"))),
			{ timeout: 8000, timeoutMsg: "responsive entity actions did not rebuild after menu-only mode" },
		);
		await browser.executeObsidian(() => {
			const region = document.querySelector<HTMLElement>(".mica-lp .mica-region");
			if (region) region.style.width = "132px";
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Array.from(document.querySelectorAll<HTMLElement>(".mica-lp [data-mica-actions]")).some(
						(button) => getComputedStyle(button).display !== "none",
					),
				),
			{ timeout: 8000, timeoutMsg: "narrow action strip did not settle after rerender" },
		);
		const coarseTarget = await browser.executeObsidian(() => {
			if (!window.matchMedia("(pointer: coarse)").matches) return null;
			const trigger = Array.from(document.querySelectorAll<HTMLElement>(".mica-lp [data-mica-actions]")).find(
				(button) => getComputedStyle(button).display !== "none",
			)!;
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
			const trigger = Array.from(document.querySelectorAll<HTMLElement>(".mica-lp [data-mica-actions]")).find(
				(button) => getComputedStyle(button).display !== "none",
			)!;
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
				const trigger = Array.from(document.querySelectorAll<HTMLElement>(".mica-lp [data-mica-actions]")).find(
					(button) => getComputedStyle(button).display !== "none",
				)!;
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
			Array.from(
				document.querySelectorAll<HTMLElement>(
					".mica-lp .mica-responsive-actions.has-overflow [data-mica-actions]",
				),
			)
				.find((button) => getComputedStyle(button).display !== "none")
				?.focus();
		});
		await browser.keys([Key.Enter]);
		await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector("body > .menu"))), {
			timeout: 8000,
			timeoutMsg: "Enter did not open the focused action menu",
		});
		await browser.keys([Key.Escape]);
		await browser.executeObsidian(async ({ app }, old) => {
			type Plugin = {
				settings: {
					actionMenuTrigger: "click" | "hover";
					entityActionLayout: "responsive" | "menu-only";
				};
				applyStyleVars(): void;
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			plugin.settings.actionMenuTrigger = old.actionMenuTrigger;
			plugin.settings.entityActionLayout = old.entityActionLayout;
			plugin.applyStyleVars();
			plugin.refreshViews();
			await plugin.saveSettings();
		}, previous);
	});

	it("applies section action visibility without changing drag or other entity actions", async function () {
		await seedAndOpen(
			"SectionActionVisibility.md",
			"```mica id=section-action-visibility\nA section with actions.\n\n:::tabs\ntab: Other\nTab body.\n:::\n```\n",
		);
		const previous = await browser.executeObsidian(async ({ app }) => {
			type SectionActionId =
				"copy" | "edit" | "lightbox" | "fields" | "convert" | "combine" | "uncombine" | "fold" | "delete";
			type Plugin = {
				settings: { hiddenSectionActions: SectionActionId[] };
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			const old = [...plugin.settings.hiddenSectionActions];
			plugin.settings.hiddenSectionActions = ["copy", "convert", "delete"];
			plugin.refreshViews();
			await plugin.saveSettings();
			return old;
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const region = document.querySelector<HTMLElement>(".mica-lp .mica-region");
					const strip = region?.querySelector<HTMLElement>(".mica-responsive-actions");
					const ids = (strip?.dataset.micaActionStrip ?? "").split(" ").filter(Boolean);
					return Boolean(
						region?.querySelector(".mica-region-grip") &&
						ids.includes("edit") &&
						!ids.some((id) => id.startsWith("copy-")) &&
						!ids.includes("delete") &&
						!ids.some((id) => id.startsWith("convert-")),
					);
				}),
			{ timeout: 8000, timeoutMsg: "section action visibility did not rebuild the section strip" },
		);
		const unaffected = await browser.executeObsidian(() => ({
			tabMenu: Boolean(document.querySelector(".mica-lp .mica-tab-chip [data-mica-actions]")),
			blockMenu: Boolean(document.querySelector(".mica-lp .mica-head [data-mica-actions]")),
		}));
		expect(unaffected.tabMenu).toBe(true);
		expect(unaffected.blockMenu).toBe(true);

		await browser.executeObsidian(() => {
			document
				.querySelector<HTMLElement>(".mica-lp .mica-region")
				?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 80 }));
		});
		await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector("body > .menu"))), {
			timeout: 8000,
			timeoutMsg: "section context menu did not open",
		});
		const menuLabels = await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll<HTMLElement>("body > .menu .menu-item-title")).map(
				(element) => element.textContent ?? "",
			),
		);
		expect(menuLabels.some((label) => label.startsWith("Copy "))).toBe(false);
		expect(menuLabels.some((label) => label.startsWith("Convert to "))).toBe(false);
		expect(menuLabels.some((label) => label.startsWith("Delete "))).toBe(false);
		expect(menuLabels).toContain("Edit source");
		await browser.executeObsidian(() => document.body.click());

		await browser.executeObsidian(async ({ app }, old) => {
			type Plugin = {
				settings: { hiddenSectionActions: string[] };
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.hiddenSectionActions = old;
			plugin.refreshViews();
			await plugin.saveSettings();
		}, previous);
	});

	it("keeps block appearance open across live changes without overflowing its rows", async function () {
		const previousAppearance = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				settings: {
					accentColor: string;
					density: "comfortable" | "compact";
					tabStyle: "connected" | "underline" | "pill";
					showOutlines: boolean;
					cardRadiusPx: number;
				};
				applyStyleVars(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			const previous = {
				accentColor: plugin.settings.accentColor,
				density: plugin.settings.density,
				tabStyle: plugin.settings.tabStyle,
				showOutlines: plugin.settings.showOutlines,
				cardRadiusPx: plugin.settings.cardRadiusPx,
			};
			plugin.settings.accentColor = "#123456";
			plugin.settings.density = "compact";
			plugin.settings.tabStyle = "pill";
			plugin.settings.showOutlines = false;
			plugin.settings.cardRadiusPx = 14;
			plugin.applyStyleVars();
			await plugin.saveSettings();
			return previous;
		});
		await seedAndOpen(
			"AppearanceSession.md",
			"```mica id=appearance-session\ntab: One\nBody.\n\ntab: Two\nMore.\n```\n",
		);
		await activateEntityAction(".mica-lp .mica-head", "appearance", "Block appearance…");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-appearance"))),
			{ timeout: 8000, timeoutMsg: "the appearance popover never opened" },
		);

		await browser.executeObsidian(() => {
			const color = document.querySelector<HTMLInputElement>('.mica-appearance input[type="color"]');
			if (!color) throw new Error("missing block accent control");
			color.value = "#d946ef";
			color.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(async ({ app, obsidian }) => {
					const file = app.vault.getAbstractFileByPath("AppearanceSession.md");
					return (
						file instanceof obsidian.TFile &&
						(await app.vault.read(file)).includes("accent=#d946ef") &&
						Boolean(document.querySelector(".mica-appearance"))
					);
				}),
			{ timeout: 8000, timeoutMsg: "the accent edit dismissed the appearance session" },
		);

		const geometry = await browser.executeObsidian(() => {
			const popover = document.querySelector<HTMLElement>(".mica-appearance")!;
			const bounds = popover.getBoundingClientRect();
			const rows = Array.from(popover.querySelectorAll<HTMLElement>(".mica-appearance-row"));
			const segmentGroups = Array.from(popover.querySelectorAll<HTMLElement>(".mica-appearance-segments"));
			return {
				badge: popover.querySelector(".mica-appearance-override")?.textContent?.trim() ?? "",
				contained: rows.every((row) =>
					Array.from(row.children).every((child) => {
						const rect = child.getBoundingClientRect();
						return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
					}),
				),
				segmentsReadable: segmentGroups.every((group) => {
					const groupBounds = group.getBoundingClientRect();
					return Array.from(group.querySelectorAll<HTMLButtonElement>("button")).every((button) => {
						const rect = button.getBoundingClientRect();
						return (
							rect.left >= groupBounds.left - 1 &&
							rect.right <= groupBounds.right + 1 &&
							button.scrollWidth <= button.clientWidth + 1
						);
					});
				}),
			};
		});
		expect(geometry.badge).toBe("Local");
		expect(geometry.contained).toBe(true);
		expect(geometry.segmentsReadable).toBe(true);

		for (const [choice, attr] of [
			["Comfy", "density=comfortable"],
			["Connected", "tabstyle=connected"],
			["On", "outline=on"],
		] as const) {
			await browser.executeObsidian((_, label) => {
				const button = Array.from(
					document.querySelectorAll<HTMLButtonElement>(".mica-appearance .mica-pop-seg"),
				).find((candidate) => candidate.textContent?.trim() === label);
				if (!button) throw new Error(`missing appearance choice: ${label}`);
				button.click();
			}, choice);
			await browser.waitUntil(
				() =>
					browser.executeObsidian(async ({ app, obsidian }, expectedAttr) => {
						const file = app.vault.getAbstractFileByPath("AppearanceSession.md");
						return (
							file instanceof obsidian.TFile &&
							(await app.vault.read(file)).includes(expectedAttr) &&
							Boolean(document.querySelector(".mica-appearance"))
						);
					}, attr),
				{ timeout: 8000, timeoutMsg: `${choice} was not saved or dismissed the appearance session` },
			);
		}

		const source = await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath("AppearanceSession.md");
			return file instanceof obsidian.TFile ? app.vault.read(file) : "";
		});
		expect(source).toContain("density=comfortable");
		expect(source).toContain("tabstyle=connected");
		expect(source).toContain("outline=on");

		const effective = await browser.executeObsidian(() => {
			const root = document.querySelector<HTMLElement>(".mica-lp.mica")!;
			const activeTab = root.querySelector<HTMLElement>(".mica-tab-btn.is-active")!;
			const region = root.querySelector<HTMLElement>(".mica-region")!;
			const rootStyle = getComputedStyle(root);
			return {
				accent: rootStyle.getPropertyValue("--mica-accent").trim(),
				gap: rootStyle.getPropertyValue("--mica-gap").trim(),
				tabRadius: getComputedStyle(activeTab).borderRadius,
				regionBorder: getComputedStyle(region).borderTopStyle,
			};
		});
		expect(effective.accent).toBe("#d946ef");
		expect(effective.gap).toBe("8px");
		expect(effective.tabRadius).not.toBe("999px");
		expect(effective.regionBorder).toBe("solid");

		await browser.executeObsidian(() => {
			const slider = document.querySelector<HTMLInputElement>('.mica-appearance input[type="range"]');
			if (!slider) throw new Error("missing block radius control");
			slider.value = "4";
			slider.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const root = document.querySelector<HTMLElement>(".mica-lp.mica");
					return (
						root?.style.getPropertyValue("--mica-radius") === "4px" &&
						root.style.getPropertyValue("--mica-accent") === "#d946ef" &&
						Boolean(document.querySelector(".mica-appearance"))
					);
				}),
			{ timeout: 8000, timeoutMsg: "radius override did not apply without disturbing the accent" },
		);

		await browser.executeObsidian(() => {
			const reset = document.querySelector<HTMLButtonElement>(
				'.mica-appearance button[aria-label*="global radius"]',
			);
			if (!reset) throw new Error("missing radius reset control");
			reset.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(async ({ app, obsidian }) => {
					const file = app.vault.getAbstractFileByPath("AppearanceSession.md");
					const source = file instanceof obsidian.TFile ? await app.vault.read(file) : "";
					const root = document.querySelector<HTMLElement>(".mica-lp.mica");
					const color = document.querySelector<HTMLInputElement>('.mica-appearance input[type="color"]');
					return (
						!source.includes("radius=") &&
						getComputedStyle(root!).getPropertyValue("--mica-radius").trim() === "14px" &&
						root?.style.getPropertyValue("--mica-accent") === "#d946ef" &&
						color?.value === "#d946ef"
					);
				}),
			{ timeout: 8000, timeoutMsg: "radius reset changed the accent or failed to restore the global radius" },
		);

		await browser.executeObsidian(() => {
			const reset = document.querySelector<HTMLButtonElement>(
				'.mica-appearance button[aria-label*="global accent"]',
			);
			if (!reset) throw new Error("missing accent reset control");
			reset.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(async ({ app, obsidian }) => {
					const file = app.vault.getAbstractFileByPath("AppearanceSession.md");
					const source = file instanceof obsidian.TFile ? await app.vault.read(file) : "";
					return !source.includes("accent=") && Boolean(document.querySelector(".mica-appearance"));
				}),
			{ timeout: 8000, timeoutMsg: "accent reset did not remove the local override or keep the popover open" },
		);
		const resetAccent = await browser.executeObsidian(() => {
			const root = document.querySelector<HTMLElement>(".mica-lp.mica")!;
			const color = document.querySelector<HTMLInputElement>('.mica-appearance input[type="color"]');
			const probe = root.createSpan();
			probe.style.color = "var(--mica-accent)";
			const probeColor = getComputedStyle(probe).color;
			probe.remove();
			return {
				computed: getComputedStyle(root).getPropertyValue("--mica-accent").trim(),
				inline: root.style.getPropertyValue("--mica-accent"),
				picker: color?.value ?? "",
				body: document.body.style.getPropertyValue("--mica-accent"),
				probeColor,
			};
		});
		expect(resetAccent.inline).toBe("");
		expect(resetAccent.body).toBe("#123456");
		expect(resetAccent.computed).toBe("#123456");
		expect(resetAccent.probeColor).toBe("rgb(18, 52, 86)");
		expect(resetAccent.picker).toBe("#123456");

		await browser.executeObsidian(() => {
			document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		});
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector(".mica-appearance")), {
			timeout: 8000,
			timeoutMsg: "outside interaction did not close the appearance popover",
		});
		await browser.executeObsidian(async ({ app }, previous) => {
			type Plugin = {
				settings: typeof previous;
				applyStyleVars(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin | null } }).plugins.getPlugin(
				"mica",
			)!;
			Object.assign(plugin.settings, previous);
			plugin.applyStyleVars();
			await plugin.saveSettings();
		}, previousAppearance);
	});

	it("keeps tab actions compact and selects icons through the runtime catalog", async function () {
		const note = "TabActionPolish.md";
		await seedAndOpen(
			note,
			"Intro.\n\n```mica id=tab-action-polish\ntab: Active\nfirst\n\ntab: Other\nsecond\n```\n",
		);
		const previous = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				settings: { showTabActionMenuOnHover: boolean };
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			const old = plugin.settings.showTabActionMenuOnHover;
			plugin.settings.showTabActionMenuOnHover = true;
			plugin.refreshViews();
			await plugin.saveSettings();
			return old;
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelectorAll(".mica-lp .mica-tab-chip").length === 2 &&
						Boolean(document.querySelector(".mica-lp .mica-tab-menu-hover")),
				),
			{ timeout: 8000, timeoutMsg: "tab fixtures did not render" },
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const chip = document.querySelector<HTMLElement>(".mica-lp .mica-tab-chip")!;
					chip.querySelector<HTMLElement>(".mica-tab-btn")?.focus();
					const trigger = chip.querySelector<HTMLElement>('[data-mica-responsive-role="overflow"]');
					return Boolean(trigger && Number(getComputedStyle(trigger).opacity) > 0);
				}),
			{ timeout: 8000, timeoutMsg: "tab dots did not reveal on keyboard focus" },
		);
		const tabPresentation = await browser.executeObsidian(() => {
			const chips = Array.from(document.querySelectorAll<HTMLElement>(".mica-lp .mica-tab-chip"));
			const active = chips[0].querySelector<HTMLElement>(".mica-tab-btn")!;
			const inactive = chips[1].querySelector<HTMLElement>(".mica-tab-btn")!;
			const trigger = chips[0].querySelector<HTMLElement>('[data-mica-responsive-role="overflow"]')!;
			return {
				directActions: chips[0].querySelectorAll('[data-mica-action]:not([style*="display: none"])').length,
				triggerOpacity: getComputedStyle(trigger).opacity,
				activeRail: getComputedStyle(active, "::after").backgroundColor,
				inactiveRail: getComputedStyle(inactive, "::after").backgroundColor,
				activeBackground: getComputedStyle(active).backgroundColor,
				inactiveBackground: getComputedStyle(inactive).backgroundColor,
			};
		});
		expect(tabPresentation.directActions).toBe(0);
		expect(Number(tabPresentation.triggerOpacity)).toBeGreaterThan(0);
		expect(tabPresentation.activeRail).not.toBe(tabPresentation.inactiveRail);
		expect(tabPresentation.activeBackground).not.toBe(tabPresentation.inactiveBackground);

		await browser.executeObsidian(({ app }) => {
			type Plugin = {
				settings: { showTabActionMenuOnHover: boolean };
				refreshViews(): void;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.showTabActionMenuOnHover = false;
			plugin.refreshViews();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const trigger = document.querySelector<HTMLElement>(
						'.mica-lp .mica-tab-chip [data-mica-responsive-role="overflow"]',
					);
					return Boolean(trigger && getComputedStyle(trigger).opacity === "0" && trigger.tabIndex === -1);
				}),
			{ timeout: 8000, timeoutMsg: "disabling tab hover dots did not apply live" },
		);
		await browser.executeObsidian(() => {
			const chip = document.querySelector<HTMLElement>(".mica-lp .mica-tab-chip")!;
			chip.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
			);
		});
		await clickLatestMenuItem("Set icon…");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-icon-picker-modal"))),
			{ timeout: 8000, timeoutMsg: "icon picker did not open" },
		);
		const initialIconPicker = await browser.executeObsidian(() => {
			const options = Array.from(document.querySelectorAll<HTMLElement>(".mica-icon-picker-option"));
			return {
				count: options.length,
				allLabelsContained: options.every((option) => {
					const label = option.querySelector<HTMLElement>(".mica-icon-picker-name");
					if (!label) return false;
					const outer = option.getBoundingClientRect();
					const inner = label.getBoundingClientRect();
					return inner.top >= outer.top && inner.bottom <= outer.bottom;
				}),
			};
		});
		expect(initialIconPicker.count).toBeLessThanOrEqual(72);
		expect(initialIconPicker.allLabelsContained).toBe(true);
		await browser.executeObsidian(() => {
			const search = document.querySelector<HTMLInputElement>(".mica-icon-picker-search input")!;
			search.value = "rocket";
			search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector('[data-icon-id*="rocket"]'))),
			{ timeout: 8000, timeoutMsg: "runtime icon search did not find rocket" },
		);
		const chosenIcon = await browser.executeObsidian(() => {
			const button = document.querySelector<HTMLButtonElement>('[data-icon-id*="rocket"]');
			const id = button?.dataset.iconId ?? "";
			button?.click();
			return id;
		});
		expect(chosenIcon).not.toBe("");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					async ({ app, obsidian }, path, icon) => {
						const file = app.vault.getAbstractFileByPath(path);
						return file instanceof obsidian.TFile
							? (await app.vault.read(file)).includes(`icon=${icon}`)
							: false;
					},
					note,
					chosenIcon,
				),
			{ timeout: 8000, timeoutMsg: "chosen tab icon was not persisted" },
		);
		const collapseAnchor = await browser.executeObsidian(() => {
			const historyCount = document.querySelectorAll<HTMLElement>(
				'.mica-lp [aria-label^="Version history"]',
			).length;
			const button = document.querySelector<HTMLButtonElement>(".mica-lp .mica-collapse-anchor")!;
			const before = button.getBoundingClientRect();
			button.click();
			return { x: before.left + before.width / 2, y: before.top + before.height / 2, historyCount };
		});
		expect(collapseAnchor.historyCount).toBe(1);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp.is-collapsed"))),
			{ timeout: 8000, timeoutMsg: "block did not collapse" },
		);
		const expandedAnchor = await browser.executeObsidian(() => {
			const button = document.querySelector<HTMLButtonElement>(".mica-lp .mica-collapse-anchor")!;
			const rect = button.getBoundingClientRect();
			const position = {
				x: rect.left + rect.width / 2,
				y: rect.top + rect.height / 2,
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
			};
			button.click();
			return position;
		});
		if (process.env.MICA_E2E_PROFILE === "mobile") {
			// Mobile scrollbars can shift the whole CodeMirror block. Prove the
			// outcome that matters: the previous touch point still hits the same
			// 40px control, so a repeated toggle requires no pointer travel.
			expect(collapseAnchor.x).toBeGreaterThanOrEqual(expandedAnchor.left);
			expect(collapseAnchor.x).toBeLessThanOrEqual(expandedAnchor.right);
			expect(collapseAnchor.y).toBeGreaterThanOrEqual(expandedAnchor.top);
			expect(collapseAnchor.y).toBeLessThanOrEqual(expandedAnchor.bottom);
		} else {
			expect(Math.abs(expandedAnchor.x - collapseAnchor.x)).toBeLessThanOrEqual(1);
			expect(Math.abs(expandedAnchor.y - collapseAnchor.y)).toBeLessThanOrEqual(1);
		}
		await browser.executeObsidian(async ({ app }, old) => {
			type Plugin = {
				settings: { showTabActionMenuOnHover: boolean };
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.showTabActionMenuOnHover = old;
			plugin.refreshViews();
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
		await browser.executeObsidian((_, blockId) => {
			const chip = document.querySelector<HTMLButtonElement>(
				`.mica-lp[data-mica-block-id="${CSS.escape(blockId)}"] .mica-chip`,
			);
			if (!chip) throw new Error("missing lineage fixture version chip");
			chip.click();
		}, id);
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
					Boolean(
						document.querySelector(".mica-inspector-selection-count")?.textContent?.includes("1 selected"),
					),
				),
			{ timeout: 8000, timeoutMsg: "the selected scope did not pin or expose its selection chip" },
		);
		await browser.executeObsidian(() => {
			const compare = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".mica-inspector-footer button"),
			).find((button) => button.textContent?.trim() === "Compare selected element");
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
		// An element is named by where it is, what it is, and which one — not by
		// the first line of its content, which cannot tell siblings apart.
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const caption =
						document.querySelector(".mica-versions-surface .mica-diff-caption")?.textContent ?? "";
					return caption.includes("Block") && caption.includes("Code block") && caption.includes("Main");
				}),
			{ timeout: 8000, timeoutMsg: "manual counterpart selection did not produce a named focused diff" },
		);
		await browser.executeObsidian(() => {
			const inspect = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".mica-versions-toolbar button"),
			).find((button) => button.textContent?.trim() === "Inspect");
			inspect?.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-inspector-render"))),
			{ timeout: 8000, timeoutMsg: "the inspector did not reopen for multi-element selection" },
		);
		await browser.executeObsidian(() => {
			const section = document.querySelector<HTMLElement>(
				'.mica-inspector-render [data-mica-inspect-key^="section:"]',
			);
			section?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelector(".mica-inspector-selection-count")?.textContent ===
						"2 selected · numbered in document order",
				),
			{ timeout: 8000, timeoutMsg: "Ctrl-click did not add a second inspected element" },
		);
		await browser.executeObsidian(() => {
			const compare = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".mica-inspector-footer button"),
			).find((button) => button.textContent?.trim() === "Compare selected elements");
			compare?.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-focused-row").length === 2),
			{ timeout: 8000, timeoutMsg: "multi-element comparison did not render one row per element" },
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

	it("defaults comparisons to real lineage and opens a searchable version picker", async function () {
		const note = "LineagePicker.md";
		const id = "lineage-picker";
		await seedAndOpen(note, `Intro.\n\n\`\`\`mica id=${id}\nBaseline body.\n\`\`\`\n`);
		await browser.executeObsidian((_, path) => window.mica.versionsSnapshot(path), note);
		await browser.executeObsidian(
			(_, path, blockId) => window.mica.blockUpdate(path, blockId, "Changed body with lineage.\n"),
			note,
			id,
		);
		const expected = await browser.executeObsidian(
			async (_, path, blockId) => {
				const versions = await window.mica.versionsList(path, blockId);
				const head = versions.at(-1);
				if (!head?.parent) throw new Error("fixture did not create a parented head");
				const parentIndex = versions.findIndex((version) => version.hash === head.parent);
				if (parentIndex < 0) throw new Error("head parent is absent from the folded history");
				await window.mica.versionsLabel(path, blockId, head.parent, "Baseline");
				return { parentNumber: parentIndex + 1, headNumber: versions.length };
			},
			note,
			id,
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					async (_, path, blockId) =>
						(await window.mica.versionsList(path, blockId)).some((version) => version.label === "Baseline"),
					note,
					id,
				),
			{ timeout: 8000, timeoutMsg: "the parent label was not visible through the version API" },
		);
		await browser.executeObsidianCommand("mica:diff-versions");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-versions-modal"))),
			{ timeout: 8000, timeoutMsg: "version history did not open" },
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					(_, parentNumber) =>
						(document.querySelector<HTMLButtonElement>(".mica-base-pick")?.textContent ?? "").includes(
							`v${parentNumber} · auto: parent`,
						),
					expected.parentNumber,
				),
			{ timeout: 8000, timeoutMsg: "Auto did not resolve to the selected head's actual parent" },
		);
		const initialRoles = await browser.executeObsidian(() => ({
			selected: Array.from(document.querySelectorAll<HTMLElement>(".mica-vrow-rolebadge.is-selected")).map(
				(badge) => badge.closest(".mica-vrow")?.querySelector(".mica-vrow-n")?.textContent ?? "",
			),
			base: Array.from(document.querySelectorAll<HTMLElement>(".mica-vrow-rolebadge.is-base")).map(
				(badge) => badge.closest(".mica-vrow")?.querySelector(".mica-vrow-n")?.textContent ?? "",
			),
		}));
		expect(initialRoles.selected).toEqual([`v${expected.headNumber}`]);
		expect(initialRoles.base).toEqual([`v${expected.parentNumber}`]);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-base-pick") as HTMLButtonElement).click();
		});
		await clickLatestMenuItem("Find version by number, label, hash, or date…");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-version-picker"))),
			{ timeout: 8000, timeoutMsg: "the version picker did not open from the Compare menu" },
		);
		await browser.executeObsidian(() => {
			const picker = Array.from(document.querySelectorAll<HTMLElement>(".mica-version-picker")).at(-1);
			const input = picker?.querySelector<HTMLInputElement>("input.prompt-input");
			if (!input) throw new Error("missing version picker search");
			input.value = "baseline";
			input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "baseline" }));
		});
		try {
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() => {
						const picker = Array.from(document.querySelectorAll<HTMLElement>(".mica-version-picker")).at(
							-1,
						);
						return Array.from(picker?.querySelectorAll(".mica-version-suggestion") ?? []).some((row) =>
							row.textContent?.includes("Baseline"),
						);
					}),
				{ timeout: 8000, timeoutMsg: "the picker did not find the labelled parent" },
			);
		} catch {
			const detail = await browser.executeObsidian(
				async (_, path, blockId) => {
					const picker = Array.from(document.querySelectorAll<HTMLElement>(".mica-version-picker")).at(-1);
					return {
						input: picker?.querySelector<HTMLInputElement>("input.prompt-input")?.value ?? null,
						status: picker?.querySelector(".mica-version-picker-status")?.textContent ?? null,
						rows: Array.from(picker?.querySelectorAll(".mica-version-suggestion") ?? []).map(
							(row) => row.textContent ?? "",
						),
						labels: (await window.mica.versionsList(path, blockId)).map((version) => version.label ?? null),
					};
				},
				note,
				id,
			);
			throw new Error(`the picker did not find the labelled parent: ${JSON.stringify(detail)}`);
		}
		await browser.executeObsidian((_, parentNumber) => {
			const picker = Array.from(document.querySelectorAll<HTMLElement>(".mica-version-picker")).at(-1);
			const row = Array.from(picker?.querySelectorAll<HTMLButtonElement>(".mica-version-suggestion") ?? []).find(
				(candidate) =>
					candidate.querySelector(".mica-version-suggestion-number")?.textContent === `v${parentNumber}`,
			);
			row?.click();
		}, expected.parentNumber);
		await browser.waitUntil(
			() =>
				browser.executeObsidian((_, parentNumber) => {
					const button = document.querySelector<HTMLButtonElement>(".mica-base-pick");
					return (
						!document.querySelector(".mica-version-picker") &&
						(button?.textContent ?? "").includes(`v${parentNumber} · pinned`)
					);
				}, expected.parentNumber),
			{ timeout: 8000, timeoutMsg: "choosing a picker row did not pin the comparison base" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-base-pick") as HTMLButtonElement).click();
		});
		await clickLatestMenuItem("Head — the current version");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					(_, headNumber) =>
						(document.querySelector<HTMLButtonElement>(".mica-base-pick")?.textContent ?? "").includes(
							`v${headNumber} · head`,
						),
					expected.headNumber,
				),
			{ timeout: 8000, timeoutMsg: "explicit Head silently substituted another version" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-base-pick") as HTMLButtonElement).click();
		});
		await clickLatestMenuItem("Auto — follow the selected version’s lineage");
		await browser.executeObsidian(() => {
			const root = Array.from(document.querySelectorAll<HTMLElement>(".mica-vrow")).find(
				(row) => row.querySelector(".mica-vrow-n")?.textContent === "v1",
			);
			root?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const button = document.querySelector<HTMLButtonElement>(".mica-base-pick");
					const selected = document
						.querySelector(".mica-vrow-rolebadge.is-selected")
						?.closest(".mica-vrow")
						?.querySelector(".mica-vrow-n")?.textContent;
					return (
						(button?.textContent ?? "").includes("auto: before first version") &&
						selected === "v1" &&
						!document.querySelector(".mica-legacy-base-help")
					);
				}),
			{
				timeout: 8000,
				timeoutMsg: "selecting a root version left stale Auto lineage controls or legacy recovery UI",
			},
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement).click();
		});
	});

	it("shows one navigator element for a combined section", async function () {
		await seedAndOpen(
			"CombinedNavigator.md",
			"Intro.\n\n```mica id=combined-navigator\n:::section\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-head"))),
			{ timeout: 8000, timeoutMsg: "combined-section fixture did not render" },
		);
		await activateEntityAction(".mica-lp .mica-head", "navigator", "Block navigator");
		await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-navpop"))), {
			timeout: 8000,
			timeoutMsg: "block navigator did not open",
		});
		const rows = await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll<HTMLElement>(".mica-navpop .mica-nav-row")).map((row) =>
				row.textContent?.trim(),
			),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Combined section");
		expect(rows[0]).toContain("First paragraph");
		await browser.keys([Key.Escape]);
	});

	it("removes and restores checkpoints through the recoverable timeline manager", async function () {
		await seedAndOpen("TimelineManagement.md", "```mica id=timeline-management\nv1\n```\n");
		const ids = await browser.executeObsidian(async () => {
			await window.mica.versionsSnapshot("TimelineManagement.md");
			await window.mica.blockUpdate("TimelineManagement.md", "timeline-management", "v2\n");
			await window.mica.blockUpdate("TimelineManagement.md", "timeline-management", "v3\n");
			return (await window.mica.versionsList("TimelineManagement.md", "timeline-management")).map(
				(version) => version.versionId,
			);
		});
		expect(ids).toHaveLength(3);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const chip = document.querySelector<HTMLButtonElement>(".mica-lp .mica-chip");
					return Boolean(chip && !chip.classList.contains("is-dirty"));
				}),
			{ timeout: 10_000, timeoutMsg: "timeline fixture did not render a clean version chip" },
		);
		await (await browser.$(".mica-lp .mica-chip")).click();
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-versions-modal"))),
			{ timeout: 8000, timeoutMsg: "version history did not open" },
		);
		// Selection is always available now: there is no Manage mode to enter,
		// and one checkbox drives both comparison and bulk actions.
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-vrow-select").length === 3),
			{ timeout: 8000, timeoutMsg: "timeline selection checkboxes were not available without a mode" },
		);
		await browser.executeObsidian((_, versionId) => {
			document
				.querySelector<HTMLInputElement>(
					`.mica-vrow-select[aria-label="Select checkpoint ${CSS.escape(versionId)}"]`,
				)
				?.click();
			// Addressed by its stable action, not its wording: a destructive
			// control's label is user-facing copy and will be reworded.
			document.querySelector<HTMLButtonElement>('[data-mica-action="remove-selected"]')?.click();
		}, ids[1]);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					(_, removedId) =>
						Boolean(document.querySelector(".mica-vrow-gap")) &&
						!Array.from(document.querySelectorAll<HTMLInputElement>(".mica-vrow-select")).some((input) =>
							input.getAttribute("aria-label")?.includes(removedId),
						) &&
						Array.from(
							document.querySelectorAll<HTMLButtonElement>(".mica-version-manage-controls button"),
						).some((button) => button.textContent?.trim() === "Removed · 1"),
					ids[1],
				),
			{ timeout: 10_000, timeoutMsg: "removed checkpoint did not leave a chronological gap" },
		);
		// The chronological gap is itself the control that reveals what sits in it.
		await browser.executeObsidian(() => {
			document.querySelector<HTMLButtonElement>("button.mica-vrow-gap")?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					(_, id) =>
						Boolean(
							document
								.querySelector<HTMLInputElement>(
									`.mica-vrow-select[aria-label="Select checkpoint ${CSS.escape(id)}"]`,
								)
								?.closest(".mica-vrow.is-removed"),
						),
					ids[1],
				),
			{ timeout: 8000, timeoutMsg: "the gap did not reveal the removed checkpoint in its chronological place" },
		);
		await browser.executeObsidian((_, id) => {
			document
				.querySelector<HTMLInputElement>(`.mica-vrow-select[aria-label="Select checkpoint ${CSS.escape(id)}"]`)
				?.click();
			document.querySelector<HTMLButtonElement>('[data-mica-action="restore-selected"]')?.click();
		}, ids[1]);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(async (_, expected) => {
					const versions = await window.mica.versionsList("TimelineManagement.md", "timeline-management");
					return versions.map((version) => version.versionId).join(",") === expected.join(",");
				}, ids),
			{ timeout: 10_000, timeoutMsg: "restoring the checkpoint did not restore original lineage order" },
		);
		await browser.executeObsidian((_, headId) => {
			document
				.querySelector<HTMLInputElement>(
					`.mica-vrow-select[aria-label="Select checkpoint ${CSS.escape(headId)}"]`,
				)
				?.click();
			document.querySelector<HTMLButtonElement>('[data-mica-action="remove-selected"]')?.click();
		}, ids[2]);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						!document.querySelector(".mica-vrow.is-working") &&
						Array.from(
							document.querySelectorAll<HTMLButtonElement>(".mica-version-manage-controls button"),
						).some((button) => button.textContent?.trim() === "Removed · 1"),
				),
			{
				timeout: 10_000,
				timeoutMsg: "hiding the raw HEAD incorrectly made its unchanged live content dirty",
			},
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const chip = document.querySelector<HTMLButtonElement>(".mica-lp .mica-chip");
					return Boolean(chip && !chip.classList.contains("is-dirty"));
				}),
			{ timeout: 8000, timeoutMsg: "the version chip stayed dirty after hiding an unchanged raw HEAD" },
		);
		const unchangedCount = await browser.executeObsidian(async () => {
			await window.mica.versionsSnapshot("TimelineManagement.md");
			return (await window.mica.versionsList("TimelineManagement.md", "timeline-management")).length;
		});
		expect(unchangedCount).toBe(2);
	});

	it("preserves the timeline sidebar position when selecting a version", async function () {
		const note = "TimelineScroll.md";
		const id = "timeline-scroll";
		await seedAndOpen(note, `\`\`\`mica id=${id}\nversion 0\n\`\`\`\n`);
		await browser.executeObsidian(
			async (_, path, blockId) => {
				await window.mica.versionsSnapshot(path);
				for (let index = 1; index <= 30; index++)
					await window.mica.blockUpdate(path, blockId, `version ${index}\n`);
			},
			note,
			id,
		);
		await (await browser.$(".mica-lp .mica-chip")).click();
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => document.querySelectorAll(".mica-versions-list .mica-vrow").length >= 25),
			{ timeout: 12_000, timeoutMsg: "long timeline did not render enough rows to scroll" },
		);
		const beforeScroll = await browser.executeObsidian(() => {
			const list = document.querySelector<HTMLElement>(".mica-versions-list");
			if (!list) throw new Error("missing version list");
			list.scrollTop = Math.min(240, list.scrollHeight - list.clientHeight);
			const target = Array.from(list.querySelectorAll<HTMLElement>(".mica-vrow")).find(
				(row) => row.querySelector(".mica-vrow-n")?.textContent === "v20",
			);
			if (!target) throw new Error("missing target version row");
			const scrollTop = list.scrollTop;
			target.click();
			return scrollTop;
		});
		expect(beforeScroll).toBeGreaterThan(0);
		await browser.waitUntil(
			() =>
				browser.executeObsidian((_, previous) => {
					const list = document.querySelector<HTMLElement>(".mica-versions-list");
					return Boolean(list && Math.abs(list.scrollTop - previous) <= 1);
				}, beforeScroll),
			{ timeout: 8000, timeoutMsg: "selecting a version reset the timeline sidebar scroll position" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement).click();
		});
	});

	it("renames tabs through Enter, Escape, and outside focus without false dirty state", async function () {
		const previousAutoSnapshot = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				settings: { autoSnapshotEnabled: boolean };
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			const previous = plugin.settings.autoSnapshotEnabled;
			plugin.settings.autoSnapshotEnabled = false;
			await plugin.saveSettings();
			return previous;
		});
		await seedAndOpen(
			"TabRenameLifecycle.md",
			[
				"```mica id=tab-rename-lifecycle",
				"tab: Original {icon=rocket}",
				":::section",
				"Alpha",
				":::",
				"tab: Second",
				":::section",
				"Beta",
				":::",
				"```",
				"",
			].join("\n"),
		);
		await browser.executeObsidian(async () => {
			await window.mica.versionsSnapshot("TabRenameLifecycle.md");
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelectorAll(".mica-lp .mica-tab-btn").length === 2 &&
						Boolean(document.querySelector(".mica-lp .mica-chip:not(.is-dirty)")),
				),
			{ timeout: 10_000, timeoutMsg: "tab rename fixture did not reach a clean rendered state" },
		);
		const before = await browser.executeObsidian(
			({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "",
		);

		await (await browser.$(".mica-lp .mica-tab-btn")).doubleClick();
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-tab-chip .mica-rename"))),
			{ timeout: 8000, timeoutMsg: "double-click did not open the tab rename input" },
		);
		const provisional = await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			return {
				source: view?.editor.getValue() ?? "",
				dirty: document.querySelector(".mica-lp .mica-chip")?.classList.contains("is-dirty") ?? true,
				selectedPath:
					document.querySelector<HTMLButtonElement>('.mica-tab-btn[aria-selected="true"]')?.dataset.micaTab ??
					null,
			};
		});
		expect(provisional.source).toBe(before);
		expect(provisional.dirty).toBe(false);
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename");
			if (!input) throw new Error("missing rename input");
			input.setSelectionRange(1, 1);
		});
		if (process.env.MICA_E2E_PROFILE === "mobile") {
			await browser.executeObsidian(() => {
				const input = document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename");
				input?.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
				);
				input?.setSelectionRange(2, 2);
			});
		} else {
			await browser.keys([Key.ArrowRight]);
		}
		const arrowState = await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename");
			const selected = document.querySelector<HTMLButtonElement>('.mica-tab-btn[aria-selected="true"]');
			return {
				inputOpen: Boolean(input),
				caret: input?.selectionStart ?? -1,
				selectedPath: selected?.dataset.micaTab ?? null,
			};
		});
		expect(arrowState.inputOpen).toBe(true);
		expect(arrowState.caret).toBe(2);
		expect(arrowState.selectedPath).toBe(provisional.selectedPath);
		await browser.executeObsidian(() => {
			document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename")?.select();
		});
		const mobileProfile = process.env.MICA_E2E_PROFILE === "mobile";
		const typeRename = async (value: string, selector = ".mica-tab-chip .mica-rename") => {
			if (!mobileProfile) {
				await browser.keys([value]);
				return;
			}
			// The mobile emulator's virtual-keyboard bridge can drop WebDriver
			// key sequences after a long suite. Dispatch the same DOM input
			// contract here while desktop retains the trusted-keyboard path.
			await browser.executeObsidian(
				(_, args) => {
					const input = document.querySelector<HTMLInputElement>(args.selector);
					if (!input) throw new Error(`Missing rename input: ${args.selector}`);
					input.value = args.value;
					input.dispatchEvent(
						new InputEvent("input", {
							bubbles: true,
							inputType: "insertText",
							data: args.value,
						}),
					);
				},
				{ selector, value },
			);
		};
		const pressRenameKey = async (key: "Enter" | "Escape") => {
			if (!mobileProfile) {
				await browser.keys([key === "Enter" ? Key.Enter : Key.Escape]);
				return;
			}
			await browser.executeObsidian((_, keyValue) => {
				const input = document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename");
				if (!input) throw new Error("Missing rename input");
				input.dispatchEvent(
					new KeyboardEvent("keydown", {
						bubbles: true,
						cancelable: true,
						key: keyValue,
					}),
				);
			}, key);
		};
		const waitForRename = async (selector = ".mica-tab-chip .mica-rename") => {
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						(_, expectedSelector) => Boolean(document.querySelector(expectedSelector)),
						selector,
					),
				{ timeout: 8000, timeoutMsg: `Rename input did not open: ${selector}` },
			);
		};
		const reopenRename = async (buttonSelector = ".mica-lp .mica-tab-btn") => {
			if (!mobileProfile) {
				await (await browser.$(buttonSelector)).doubleClick();
				return;
			}
			await browser.executeObsidian((_, selector) => {
				const button = document.querySelector<HTMLElement>(selector);
				if (!button) throw new Error(`Missing tab button: ${selector}`);
				button.dispatchEvent(
					new MouseEvent("dblclick", {
						bubbles: true,
						cancelable: true,
						view: window,
					}),
				);
			}, buttonSelector);
		};
		// Type through the focused control instead of holding a WebDriver element
		// reference: CodeMirror may legitimately replace the surrounding widget
		// while the provisional edit session resumes on the new DOM node.
		await typeRename("Cancelled");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename")?.value === "Cancelled",
				),
			{ timeout: 8000, timeoutMsg: "trusted typing did not reach the provisional tab title" },
		);
		const typedOnly = await browser.executeObsidian(({ app, obsidian }) => ({
			source: app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "",
			dirty: document.querySelector(".mica-lp .mica-chip")?.classList.contains("is-dirty") ?? true,
		}));
		expect(typedOnly.source).toBe(before);
		expect(typedOnly.dirty).toBe(false);
		await pressRenameKey("Escape");
		await browser.waitUntil(
			() => browser.executeObsidian(() => !document.querySelector(".mica-tab-chip .mica-rename")),
			{ timeout: 8000, timeoutMsg: "Escape did not close the rename input" },
		);
		expect(
			await browser.executeObsidian(
				({ app, obsidian }) =>
					app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "",
			),
		).toBe(before);

		await reopenRename();
		await waitForRename();
		await typeRename("Renamed");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename")?.value === "Renamed",
				),
			{ timeout: 8000, timeoutMsg: "trusted typing did not reach the resumed tab title" },
		);
		await pressRenameKey("Enter");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const source = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return (
						!document.querySelector(".mica-tab-chip .mica-rename") &&
						source.includes("tab: Renamed {icon=rocket}") &&
						Boolean(document.querySelector(".mica-lp .mica-chip.is-dirty"))
					);
				}),
			{ timeout: 8000, timeoutMsg: "Enter did not commit the tab title exactly once" },
		);
		const afterEnter = await browser.executeObsidian(
			({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "",
		);
		expect(afterEnter).toContain("tab: Renamed {icon=rocket}");
		expect(afterEnter).not.toContain("tab: Original");

		await reopenRename(".mica-lp .mica-tab-chip:nth-of-type(2) .mica-tab-btn");
		await waitForRename(".mica-lp .mica-tab-chip:nth-of-type(2) .mica-rename");
		await typeRename("Outside", ".mica-lp .mica-tab-chip:nth-of-type(2) .mica-rename");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelector<HTMLInputElement>(".mica-lp .mica-tab-chip:nth-of-type(2) .mica-rename")
							?.value === "Outside",
				),
			{ timeout: 8000, timeoutMsg: "trusted typing did not reach the second tab title" },
		);
		await (await browser.$(".mica-lp .mica-head")).click();
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					({ app, obsidian }) =>
						(app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "").includes(
							"tab: Outside",
						) && !document.querySelector(".mica-tab-chip .mica-rename"),
				),
			{ timeout: 8000, timeoutMsg: "outside focus did not commit and close the tab rename" },
		);

		await reopenRename();
		await waitForRename();
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename")!;
			input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "編" }));
			input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }));
		});
		expect(
			await browser.executeObsidian(() => Boolean(document.querySelector(".mica-tab-chip .mica-rename"))),
		).toBe(true);
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>(".mica-tab-chip .mica-rename")!;
			input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "編" }));
		});
		await pressRenameKey("Escape");

		await browser.executeObsidian(async ({ app }, previous) => {
			type Plugin = {
				settings: { autoSnapshotEnabled: boolean };
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.autoSnapshotEnabled = previous;
			await plugin.saveSettings();
		}, previousAutoSnapshot);
	});

	it("copies only the exact combined section nested inside a tab", async function () {
		await seedAndOpen(
			"ScopedCombinedClipboard.md",
			[
				"```mica id=scoped-combined-copy",
				"tab: Selected tab",
				":::section",
				"  selected",
				"",
				":::cell",
				"nested",
				":::",
				":::",
				":::section",
				"Unselected section",
				":::",
				"tab: Sibling tab",
				":::section",
				"Sibling tab body",
				":::",
				"```",
				"",
			].join("\n"),
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-logical-section").length >= 2),
			{ timeout: 8000, timeoutMsg: "nested combined sections did not render" },
		);
		const outputs = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				settings: {
					copyIncludeMicaSyntax: boolean;
					copyIncludeOuterContainer: boolean;
					copyIncludeLineNumbers: boolean;
					copyLineNumberScope: "content" | "output";
				};
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			const clipboard = navigator.clipboard;
			const originalWrite = clipboard.writeText;
			const prior = {
				syntax: plugin.settings.copyIncludeMicaSyntax,
				outer: plugin.settings.copyIncludeOuterContainer,
				numbers: plugin.settings.copyIncludeLineNumbers,
				scope: plugin.settings.copyLineNumberScope,
			};
			const copied: string[] = [];
			Object.defineProperty(clipboard, "writeText", {
				configurable: true,
				value: async (text: string) => {
					copied.push(text);
				},
			});
			const clickCopy = async (): Promise<void> => {
				const tools = document.querySelector<HTMLElement>(
					".mica-lp .mica-tab-panel.is-active .mica-logical-section .mica-region-tools",
				);
				const direct = tools?.querySelector<HTMLButtonElement>('[data-mica-action="copy-text"]');
				if (direct && getComputedStyle(direct).display !== "none") direct.click();
				else {
					tools?.querySelector<HTMLButtonElement>('[data-mica-responsive-role="overflow"]')?.click();
					const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).at(-1);
					Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? [])
						.find(
							(item) =>
								item.querySelector(".menu-item-title")?.textContent?.trim() === "Copy combined section",
						)
						?.click();
				}
				await Promise.resolve();
			};
			try {
				plugin.settings.copyIncludeLineNumbers = false;
				plugin.settings.copyIncludeMicaSyntax = false;
				plugin.settings.copyIncludeOuterContainer = false;
				await clickCopy();
				plugin.settings.copyIncludeMicaSyntax = true;
				plugin.settings.copyIncludeOuterContainer = true;
				await clickCopy();
			} finally {
				plugin.settings.copyIncludeMicaSyntax = prior.syntax;
				plugin.settings.copyIncludeOuterContainer = prior.outer;
				plugin.settings.copyIncludeLineNumbers = prior.numbers;
				plugin.settings.copyLineNumberScope = prior.scope;
				Object.defineProperty(clipboard, "writeText", { configurable: true, value: originalWrite });
			}
			return copied;
		});
		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toBe("  selected\n\nnested\n");
		expect(outputs[1]).toBe("```mica\n:::section\n  selected\n\n:::cell\nnested\n:::\n:::\n```");
		for (const output of outputs) {
			expect(output).not.toContain("Unselected section");
			expect(output).not.toContain("Sibling tab");
			expect(output).not.toContain("tab:");
		}
	});

	it("hands one long-block status cluster from header to dock to footer", async function () {
		const body = Array.from({ length: 70 }, (_, index) => `:::section\nLong section ${index}\n:::\n`).join("");
		const previous = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				settings: {
					longBlockControls: "contextual" | "jumps-only" | "off";
					autoSnapshotEnabled: boolean;
					showVersionChip: boolean;
					headerMode: "hover" | "always" | "never";
					copyIncludeMicaSyntax: boolean;
					copyIncludeOuterContainer: boolean;
					copyIncludeLineNumbers: boolean;
					copyLineNumberScope: "content" | "output";
				};
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			const old = { ...plugin.settings };
			plugin.settings.longBlockControls = "contextual";
			plugin.settings.autoSnapshotEnabled = false;
			plugin.settings.showVersionChip = true;
			plugin.settings.headerMode = "hover";
			plugin.settings.copyIncludeMicaSyntax = false;
			plugin.settings.copyIncludeOuterContainer = false;
			plugin.settings.copyIncludeLineNumbers = false;
			plugin.settings.copyLineNumberScope = "content";
			plugin.refreshViews();
			await plugin.saveSettings();
			return old;
		});
		await seedAndOpen(
			"LongBlockControls.md",
			`Intro.\n\n\`\`\`mica id=long-controls name="Long block"\n${body}\`\`\`\n`,
		);
		await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp.mica"))), {
			timeout: 12_000,
			timeoutMsg: "the long Live Preview block did not render",
		});
		await browser.executeObsidian(() => {
			const root = document.querySelector<HTMLElement>(".mica-lp.mica");
			const scroller = root?.closest<HTMLElement>(".cm-scroller");
			if (!root || !scroller) throw new Error("missing live-edit long block scrollport");
			scroller.scrollTop = Math.max(
				0,
				scroller.scrollTop + root.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
			);
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const root = document.querySelector<HTMLElement>(".mica-lp.mica");
					return root?.dataset.micaLongPlacement === "top";
				}),
			{ timeout: 12000, timeoutMsg: "the tall block did not activate top status controls" },
		);
		const topState = await browser.executeObsidian(() => ({
			headerClusters: document.querySelectorAll(".mica-long-head-slot .mica-status-cluster").length,
			footerClusters: document.querySelectorAll(".mica-long-footer-slot .mica-status-cluster").length,
			save: document.querySelectorAll(".mica-long-head-slot .mica-save-now").length,
			history: document.querySelectorAll(".mica-long-head-slot .mica-chip").length,
			copy: document.querySelectorAll(".mica-long-head-slot .mica-long-copy").length,
		}));
		expect(topState.headerClusters).toBe(1);
		expect(topState.footerClusters).toBe(0);
		expect(topState.save).toBe(1);
		expect(topState.history).toBe(1);
		expect(topState.copy).toBe(1);
		const topGap = await browser.executeObsidian(() => {
			const save = document.querySelector<HTMLElement>(".mica-long-head-slot .mica-save-now")!;
			const history = document.querySelector<HTMLElement>(".mica-long-head-slot .mica-chip")!;
			return history.getBoundingClientRect().left - save.getBoundingClientRect().right;
		});
		expect(topGap).toBeGreaterThanOrEqual(5);
		await browser.executeObsidian(() => {
			const style = document.createElement("style");
			style.id = "mica-test-hostile-live-dock";
			style.textContent =
				".markdown-source-view .mica-long-dock-host { position: relative !important; top: auto !important; }";
			document.head.appendChild(style);
		});
		await browser.executeObsidian(() => {
			const root = document.querySelector<HTMLElement>(".mica-lp.mica");
			const scroller = root?.closest(".cm-scroller") as HTMLElement | null;
			if (!root || !scroller) throw new Error("missing live-edit long block scrollport");
			const rootRect = root.getBoundingClientRect();
			const scrollRect = scroller.getBoundingClientRect();
			scroller.scrollTop += rootRect.top + rootRect.height / 2 - (scrollRect.top + scrollRect.height / 2);
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const root = document.querySelector<HTMLElement>(".mica-lp.mica");
					const travel = document.querySelector<HTMLElement>(
						".mica-live-long-dock-portal .mica-long-dock > .mica-long-travel:not(.is-jumps-only)",
					);
					return Boolean(
						root?.dataset.micaLongPlacement === "middle" &&
						travel &&
						getComputedStyle(travel).opacity === "1" &&
						getComputedStyle(travel).pointerEvents !== "none",
					);
				}),
			{ timeout: 12_000, timeoutMsg: "the live-edit traveling dock was not visible in the middle" },
		);
		const liveDockMiddle = await browser.executeObsidian(() => {
			const root = document.querySelector<HTMLElement>(".mica-lp.mica")!;
			const scroller = root.closest(".cm-scroller") as HTMLElement;
			const travel = document.querySelector<HTMLElement>(
				".mica-live-long-dock-portal .mica-long-dock > .mica-long-travel:not(.is-jumps-only)",
			)!;
			const token = crypto.randomUUID();
			travel.dataset.testIdentity = token;
			const visibleActions = Array.from(
				travel.querySelectorAll<HTMLElement>("[data-mica-dock-action], [data-mica-action]"),
			).filter((element) => element.getClientRects().length > 0);
			const actionCounts = new Map<string, number>();
			for (const element of visibleActions) {
				const id = element.dataset.micaDockAction ?? element.dataset.micaAction;
				if (id) actionCounts.set(id, (actionCounts.get(id) ?? 0) + 1);
			}
			const actionRects = visibleActions
				.filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement)
				.map((element) => element.getBoundingClientRect())
				.sort((left, right) => left.left - right.left);
			return {
				token,
				top: travel.getBoundingClientRect().top,
				width: travel.getBoundingClientRect().width,
				copyWidth:
					travel.querySelector<HTMLElement>('[data-mica-dock-action="copy"]')?.getBoundingClientRect()
						.width ?? 0,
				duplicateActions: [...actionCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
				overlappingActions: actionRects.some(
					(rect, index) => index > 0 && rect.left < actionRects[index - 1].right - 0.5,
				),
				rootTop: root.getBoundingClientRect().top,
				scrollTop: scroller.scrollTop,
			};
		});
		// A shrink-to-fit floating element must not also contain its own inline
		// size. That combination used to collapse the whole dock into a narrow
		// vertical pill even though its controls were still mounted.
		expect(liveDockMiddle.width).toBeGreaterThanOrEqual(80);
		expect(liveDockMiddle.copyWidth).toBeGreaterThanOrEqual(20);
		expect(liveDockMiddle.duplicateActions).toEqual([]);
		expect(liveDockMiddle.overlappingActions).toBe(false);
		const renderedDockCopy = await browser.executeObsidian(async () => {
			const clipboard = navigator.clipboard as Clipboard & { writeText: (text: string) => Promise<void> };
			const originalWrite = clipboard.writeText;
			let copied = "";
			Object.defineProperty(clipboard, "writeText", {
				configurable: true,
				value: async (text: string) => {
					copied = text;
				},
			});
			try {
				(
					document.querySelector(
						'.mica-live-long-dock-portal [data-mica-dock-action="copy"]',
					) as HTMLButtonElement
				).click();
				await new Promise((resolve) => setTimeout(resolve, 0));
				return {
					copied,
					target:
						document.querySelector(".mica-live-long-dock-portal .mica-long-scope-text")?.textContent ?? "",
				};
			} finally {
				Object.defineProperty(clipboard, "writeText", { configurable: true, value: originalWrite });
			}
		});
		expect(renderedDockCopy.copied).toContain("Long section");
		expect(renderedDockCopy.copied).not.toContain("```mica");
		expect(renderedDockCopy.copied).not.toContain("id=long-controls");
		expect(renderedDockCopy.target).toMatch(/Text|section|block/i);
		await browser.executeObsidian(() => {
			const root = document.querySelector<HTMLElement>(".mica-lp.mica")!;
			const scroller = root.closest(".cm-scroller") as HTMLElement;
			scroller.scrollTop += Math.min(240, Math.max(80, scroller.clientHeight / 4));
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian((_, expected) => {
					const root = document.querySelector<HTMLElement>(".mica-lp.mica");
					const travel = document.querySelector<HTMLElement>(
						".mica-live-long-dock-portal .mica-long-dock > .mica-long-travel:not(.is-jumps-only)",
					);
					return Boolean(
						root?.dataset.micaLongPlacement === "middle" && travel?.dataset.testIdentity === expected,
					);
				}, liveDockMiddle.token),
			{ timeout: 12_000, timeoutMsg: "live-edit middle dock rebuilt or left its middle placement" },
		);
		const liveDockAfterScroll = await browser.executeObsidian(() => {
			const root = document.querySelector<HTMLElement>(".mica-lp.mica")!;
			const scroller = root.closest(".cm-scroller") as HTMLElement;
			const travel = document.querySelector<HTMLElement>(
				".mica-live-long-dock-portal .mica-long-dock > .mica-long-travel:not(.is-jumps-only)",
			)!;
			return {
				top: travel.getBoundingClientRect().top,
				rootTop: root.getBoundingClientRect().top,
				scrollTop: scroller.scrollTop,
			};
		});
		expect(liveDockAfterScroll.scrollTop - liveDockMiddle.scrollTop).toBeGreaterThan(50);
		expect(Math.abs(liveDockAfterScroll.rootTop - liveDockMiddle.rootTop)).toBeGreaterThan(50);
		expect(Math.abs(liveDockAfterScroll.top - liveDockMiddle.top)).toBeLessThanOrEqual(2);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-long-dock .mica-long-jump.is-bottom") as HTMLButtonElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelector<HTMLElement>(".mica-lp.mica")?.dataset.micaLongPlacement === "bottom",
				),
			{ timeout: 12000, timeoutMsg: "jump to bottom did not hand controls to the footer" },
		);
		const bottomState = await browser.executeObsidian(() => ({
			headerClusters: document.querySelectorAll(".mica-long-head-slot .mica-status-cluster").length,
			footerClusters: document.querySelectorAll(".mica-long-footer-slot .mica-status-cluster").length,
			topJump: document.querySelectorAll(".mica-long-footer-slot .mica-long-jump.is-top").length,
		}));
		expect(bottomState.headerClusters).toBe(0);
		expect(bottomState.footerClusters).toBe(1);
		expect(bottomState.topJump).toBe(1);
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			if (!view) throw new Error("missing markdown view");
			await view.setState({ mode: "source", source: true }, { history: false });
			view.editor.setCursor({ line: 3, ch: 0 });
			view.editor.focus();
			const scroller = view.containerEl.querySelector<HTMLElement>(".cm-scroller");
			if (!scroller) throw new Error("missing CodeMirror scrollport");
			scroller.scrollTop = 0;
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const dock = document.querySelector<HTMLElement>(".mica-source-dock");
					return Boolean(
						dock &&
						!dock.hidden &&
						dock.dataset.micaSourcePlacement === "top" &&
						dock.querySelector('[aria-label="Version history"]'),
					);
				}),
			{ timeout: 10_000, timeoutMsg: "the long full-Source dock did not appear at the fence" },
		);
		const sourceDock = await browser.executeObsidian(() => {
			const dock = document.querySelector<HTMLElement>(".mica-source-dock")!;
			return {
				name: dock.querySelector(".mica-source-dock-name")?.textContent,
				jumps: dock.querySelectorAll(".mica-source-dock-button").length,
				placement: dock.dataset.micaSourcePlacement,
				width: dock.getBoundingClientRect().width,
				copyWidth:
					dock.querySelector<HTMLElement>('[data-mica-dock-action="copy"]')?.getBoundingClientRect().width ??
					0,
			};
		});
		expect(sourceDock.name).toBe("Long block");
		expect(sourceDock.jumps).toBeGreaterThanOrEqual(4);
		expect(["top", "middle", "bottom"]).toContain(sourceDock.placement);
		expect(sourceDock.width).toBeGreaterThanOrEqual(80);
		expect(sourceDock.copyWidth).toBeGreaterThanOrEqual(20);
		await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			if (!view) throw new Error("missing markdown view");
			view.editor.setCursor({ line: 19, ch: 4 });
			view.editor.focus();
		});
		const beforeRawEdit = await browser.executeObsidian(
			({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "",
		);
		await browser.keys(["Z"]);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector('.mica-source-dock [aria-label="Undo last block edit"]')),
				),
			{ timeout: 8000, timeoutMsg: "raw-source typing did not create a block-local Undo entry" },
		);
		const sourceDockCopy = await browser.executeObsidian(async () => {
			const clipboard = navigator.clipboard as Clipboard & { writeText: (text: string) => Promise<void> };
			const originalWrite = clipboard.writeText;
			let copied = "";
			Object.defineProperty(clipboard, "writeText", {
				configurable: true,
				value: async (text: string) => {
					copied = text;
				},
			});
			try {
				(
					document.querySelector('.mica-source-dock [data-mica-dock-action="copy"]') as HTMLButtonElement
				).click();
				await new Promise((resolve) => setTimeout(resolve, 0));
				return copied;
			} finally {
				Object.defineProperty(clipboard, "writeText", { configurable: true, value: originalWrite });
			}
		});
		expect(sourceDockCopy).toContain("LongZ section 5");
		expect(sourceDockCopy).not.toContain("id=long-controls");
		await browser.executeObsidian(() =>
			(
				document.querySelector(
					'.mica-source-dock [aria-label="Undo last block edit"]',
				) as HTMLButtonElement | null
			)?.click(),
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					({ app, obsidian }, expected) =>
						(app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "") ===
						expected,
					beforeRawEdit,
				),
			{ timeout: 8000, timeoutMsg: "raw-source Undo did not restore the exact note" },
		);
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			if (!view) throw new Error("missing markdown view");
			await view.setState({ mode: "source", source: true }, { history: false });
			view.editor.setCursor({ line: 19, ch: 4 });
			view.editor.focus();
			const scroller = view.containerEl.querySelector<HTMLElement>(".cm-scroller");
			if (!scroller) throw new Error("missing CodeMirror scrollport");
			scroller.scrollTop = 0;
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const dock = document.querySelector<HTMLElement>(".mica-source-dock");
					return Boolean(dock && !dock.hidden && dock.dataset.micaSourcePlacement === "top");
				}),
			{ timeout: 10_000, timeoutMsg: "full Source mode did not show the dock at the opening fence" },
		);
		const fullSourceToken = await browser.executeObsidian(({ app, obsidian }) => {
			const dock = document.querySelector<HTMLElement>(".mica-source-dock")!;
			const token = crypto.randomUUID();
			dock.dataset.testIdentity = token;
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			return { token, cursorLine: view?.editor.getCursor().line ?? -1 };
		});
		await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView)!;
			const scroller = view.containerEl.querySelector<HTMLElement>(".cm-scroller")!;
			scroller.scrollTop = Math.max(1, (scroller.scrollHeight - scroller.clientHeight) / 2);
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian((_, token) => {
					const dock = document.querySelector<HTMLElement>(".mica-source-dock");
					return Boolean(
						dock &&
						!dock.hidden &&
						dock.dataset.testIdentity === token &&
						dock.dataset.micaSourcePlacement === "middle",
					);
				}, fullSourceToken.token),
			{
				timeout: 10_000,
				timeoutMsg: "full Source dock did not travel through the middle without rebuilding",
			},
		);
		const sourceDockMiddle = await browser.executeObsidian(() => {
			const dock = document.querySelector<HTMLElement>(".mica-source-dock")!;
			const scroller = dock.closest(".cm-editor")?.querySelector<HTMLElement>(".cm-scroller");
			if (!scroller) throw new Error("missing source dock scrollport");
			return { top: dock.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
		});
		await browser.executeObsidian(() => {
			const dock = document.querySelector<HTMLElement>(".mica-source-dock")!;
			const scroller = dock.closest(".cm-editor")?.querySelector<HTMLElement>(".cm-scroller");
			if (!scroller) throw new Error("missing source dock scrollport");
			scroller.scrollTop += Math.min(180, Math.max(60, scroller.clientHeight / 5));
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelector<HTMLElement>(".mica-source-dock")?.dataset.micaSourcePlacement ===
						"middle",
				),
			{ timeout: 10_000, timeoutMsg: "source dock left the middle during continued scrolling" },
		);
		const sourceDockAfterScroll = await browser.executeObsidian(() => {
			const dock = document.querySelector<HTMLElement>(".mica-source-dock")!;
			const scroller = dock.closest(".cm-editor")?.querySelector<HTMLElement>(".cm-scroller");
			if (!scroller) throw new Error("missing source dock scrollport");
			return { top: dock.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
		});
		expect(sourceDockAfterScroll.scrollTop - sourceDockMiddle.scrollTop).toBeGreaterThan(40);
		expect(Math.abs(sourceDockAfterScroll.top - sourceDockMiddle.top)).toBeLessThanOrEqual(2);
		expect(
			await browser.executeObsidian(
				({ app, obsidian }) =>
					app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getCursor().line,
			),
		).toBe(fullSourceToken.cursorLine);
		await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView)!;
			const scroller = view.containerEl.querySelector<HTMLElement>(".cm-scroller")!;
			scroller.scrollTop = scroller.scrollHeight;
			scroller.dispatchEvent(new Event("scroll"));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian((_, token) => {
					const dock = document.querySelector<HTMLElement>(".mica-source-dock");
					return Boolean(
						dock &&
						!dock.hidden &&
						dock.dataset.testIdentity === token &&
						dock.dataset.micaSourcePlacement === "bottom",
					);
				}, fullSourceToken.token),
			{ timeout: 10_000, timeoutMsg: "full Source dock did not align with the closing fence" },
		);
		await browser.executeObsidian(async ({ app }, old) => {
			type Plugin = {
				settings: {
					longBlockControls: "contextual" | "jumps-only" | "off";
					autoSnapshotEnabled: boolean;
					showVersionChip: boolean;
					headerMode: "hover" | "always" | "never";
					copyIncludeMicaSyntax: boolean;
					copyIncludeOuterContainer: boolean;
					copyIncludeLineNumbers: boolean;
					copyLineNumberScope: "content" | "output";
				};
				refreshViews(): void;
				saveSettings(): Promise<void>;
			};
			const plugin = (app as unknown as { plugins: { getPlugin(id: string): Plugin } }).plugins.getPlugin("mica");
			plugin.settings.longBlockControls = old.longBlockControls;
			plugin.settings.autoSnapshotEnabled = old.autoSnapshotEnabled;
			plugin.settings.showVersionChip = old.showVersionChip;
			plugin.settings.headerMode = old.headerMode;
			plugin.settings.copyIncludeMicaSyntax = old.copyIncludeMicaSyntax;
			plugin.settings.copyIncludeOuterContainer = old.copyIncludeOuterContainer;
			plugin.settings.copyIncludeLineNumbers = old.copyIncludeLineNumbers;
			plugin.settings.copyLineNumberScope = old.copyLineNumberScope;
			plugin.refreshViews();
			await plugin.saveSettings();
		}, previous);
	});
});
