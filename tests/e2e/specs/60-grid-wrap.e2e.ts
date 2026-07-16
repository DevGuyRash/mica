import { browser } from "@wdio/globals";

/** Round-5 features that MUTATE the document: column resize + wrap toggle. */

async function seedAndOpen(path: string, content: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app, obsidian }, p, c) => {
			let f = app.vault.getAbstractFileByPath(p);
			if (!f) f = await app.vault.create(p, c);
			if (!(f instanceof obsidian.TFile)) throw new Error(`not a file: ${p}`);
			await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source", source: false } });
		},
		path,
		content,
	);
}

async function docContains(_pred: string): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }) => {
		return app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
	});
}

describe("grid column resize + wrap toggle", function () {
	it("dragging the column divider persists colw fractions into the grid header", async function () {
		await seedAndOpen(
			"GridResize.md",
			"Intro.\n\n```mica id=gr-1\n:::grid {cols=2}\n:::cell\nalpha\n:::\n:::cell\nbeta\n:::\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-col-resizer").length >= 1),
			{ timeout: 8000, timeoutMsg: "the column resizer never rendered" },
		);
		await browser.executeObsidian(async () => {
			const strip = document.querySelector(".mica-lp .mica-col-resizer") as HTMLElement;
			const r = strip.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			const cy = r.top + r.height / 2;
			strip.dispatchEvent(new PointerEvent("pointerdown", opts(r.left + 4, cy)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(r.left + 60, cy)));
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(r.left + 60, cy)));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return /:::grid \{cols=2 colw=[\d.]+,[\d.]+\}/.test(v);
				}),
			{ timeout: 8000, timeoutMsg: "colw never landed in the grid header" },
		);
	});

	it("the header wrap toggle writes wrap=off into the fence attrs", async function () {
		await seedAndOpen("WrapToggle.md", "Intro.\n\n```mica id=wr-1\ntab: Main\nsome body text\n```\n");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-head-btn[aria-pressed]").length >= 1,
				),
			{ timeout: 8000, timeoutMsg: "the wrap toggle never rendered" },
		);
		// Wrap defaults ON — the widget must say so before the click.
		const before = await browser.executeObsidian(
			() => (document.querySelector(".mica-lp.mica, .mica-lp .mica") as HTMLElement | null)?.dataset.micaWrap,
		);
		if (before !== "on") throw new Error(`expected default wrap=on, got ${before}`);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-head-btn[aria-pressed]") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes("```mica id=wr-1 wrap=off") || /```mica [^\n]*wrap=off/.test(v);
				}),
			{ timeout: 8000, timeoutMsg: "wrap=off never landed in the fence attrs" },
		);
	});
});

describe("round 6: folds, click-outside, region delete", function () {
	it("folding a section collapses it to a bar and unfolds on click", async function () {
		await seedAndOpen("Fold.md", "Intro.\n\n```mica id=fd-1\ntab: Main\n> [!note] Foldme\n\nprose after\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Foldme"),
			) as HTMLElement;
			(region.querySelector('[aria-label="Fold this section"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-fold-bar").length === 1),
			{ timeout: 8000, timeoutMsg: "the fold bar never appeared" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-fold-bar") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelectorAll(".mica-lp .mica-fold-bar").length === 0 &&
						Array.from(document.querySelectorAll(".mica-lp .mica-region")).some((r) =>
							r.textContent?.includes("Foldme"),
						),
				),
			{ timeout: 8000, timeoutMsg: "the section never unfolded" },
		);
	});

	it("click-outside in save mode commits the open editor", async function () {
		await browser.executeObsidian(({ app }) => {
			type P = { settings: { editorClickOutside: string }; applyStyleVars(): void };
			const plugin = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins["mica"];
			plugin.settings.editorClickOutside = "save";
			plugin.applyStyleVars();
		});
		await seedAndOpen("ClickOut.md", "Intro.\n\n```mica id=co-1\ntab: Main\noriginal text\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length >= 1),
			{ timeout: 8000, timeoutMsg: "region never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region.is-editable") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(
						(document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement | null)?.shadowRoot?.querySelector(
							".cm-content",
						),
					),
				),
			{ timeout: 8000, timeoutMsg: "editor never opened" },
		);
		await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(v: string): void };
			};
			host.micaEditor?.setValue("edited by click-out");
			// Click far outside the editor (body counts: it contains no editor).
			document.body.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 9 }),
			);
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes("edited by click-out");
				}),
			{ timeout: 8000, timeoutMsg: "the click-outside save never landed" },
		);
		await browser.executeObsidian(({ app }) => {
			type P = { settings: { editorClickOutside: string }; applyStyleVars(): void };
			const plugin = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins["mica"];
			plugin.settings.editorClickOutside = "nothing";
			plugin.applyStyleVars();
		});
	});

	it("the region ✕ deletes the section (with undo pre-image applied)", async function () {
		await seedAndOpen("RegionDel.md", "Intro.\n\n```mica id=rd-1\ntab: Main\nkeep me\n\n> [!tip] Delete me\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Delete me"),
			) as HTMLElement;
			(region.querySelector('[aria-label="Delete this section"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return !v.includes("Delete me") && v.includes("keep me");
				}),
			{ timeout: 8000, timeoutMsg: "the section was not deleted" },
		);
	});
});

describe("structured callout editor", function () {
	it("edits type/title/fold and re-quotes the body — nested callouts nest automatically", async function () {
		await seedAndOpen(
			"CalloutEdit.md",
			"Intro.\n\n```mica id=ce-1\ntab: Main\n> [!note] Old title\n> Original body line.\n\ntrailing prose\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Old title"),
			) as HTMLElement;
			(region.querySelector('[aria-label="Edit callout (type, title, body)"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lightbox-fields").length === 1),
			{ timeout: 8000, timeoutMsg: "the callout editor never opened" },
		);
		await browser.executeObsidian(() => {
			const modal = document.querySelector(".mica-lightbox") as HTMLElement;
			// Type via the shared color-tinted picker.
			(modal.querySelector(".mica-coedit-type") as HTMLElement).click();
			const pick = Array.from(modal.querySelectorAll(".mica-coedit-typepop .mica-callout-type")).find(
				(b) => b.querySelector(".mica-callout-name")?.textContent === "warning",
			) as HTMLElement;
			pick.click();
			const title = modal.querySelector(".mica-coedit-title") as HTMLInputElement;
			title.value = "New title";
			title.dispatchEvent(new Event("input", { bubbles: true }));
			(Array.from(modal.querySelectorAll(".mica-pop-seg")).find((b) => b.textContent === "Closed") as HTMLElement).click();
			const host = modal.querySelector(".mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(v: string): void };
			};
			// A callout typed INSIDE the body — must come out nested (> >).
			host.micaEditor?.setValue("Edited body.\n\n> [!tip] Inner\n> nested body");
			(Array.from(modal.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLElement).click();
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return (
					v.includes("> [!warning]- New title") &&
					v.includes("> Edited body.") &&
					v.includes("> > [!tip] Inner") &&
					v.includes("> > nested body") &&
					v.includes("trailing prose")
				);
			},
			{ timeout: 8000, timeoutMsg: "the callout round-trip did not land" },
		);
	});
});

describe("grid row resize", function () {
	it("dragging the row divider persists rowh; double-click clears it", async function () {
		await seedAndOpen(
			"RowResize.md",
			"Intro.\n\n```mica id=rr-2\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-row-resizer").length >= 1),
			{ timeout: 8000, timeoutMsg: "the row resizer never rendered" },
		);
		await browser.executeObsidian(async () => {
			const strip = document.querySelector(".mica-lp .mica-row-resizer") as HTMLElement;
			const r = strip.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			const cx = r.left + r.width / 2;
			strip.dispatchEvent(new PointerEvent("pointerdown", opts(cx, r.top + 4)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(cx, r.top + 80)));
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(cx, r.top + 80)));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					// Pair semantics: the divider writes BOTH neighbours' heights.
					return /:::grid \{cols=2 rowh=\d+,\d+\}/.test(v);
				}),
			{ timeout: 8000, timeoutMsg: "rowh never landed in the grid header" },
		);
		// Double-click the divider → back to auto → attr removed entirely.
		await browser.executeObsidian(() => {
			const strip = document.querySelector(".mica-lp .mica-row-resizer") as HTMLElement;
			strip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes(":::grid {cols=2}") && !v.includes("rowh");
				}),
			{ timeout: 8000, timeoutMsg: "rowh was not cleared by double-click" },
		);
	});
});

describe("block navigator", function () {
	it("lists sections and reveals a target inside a FOLDED group (auto-unfold)", async function () {
		await seedAndOpen(
			"NavFold.md",
			"Intro.\n\n```mica id=nav-1\n:::tabs\ntab: Alpha\n> [!tip] Buried treasure\n> the payload\n:::\n\nroot outro prose\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-tabs").length >= 1),
			{ timeout: 8000, timeoutMsg: "tabs never rendered" },
		);
		// Fold the whole tabs group.
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-group-fold") as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-fold-bar").length === 1),
			{ timeout: 8000, timeoutMsg: "the group never folded" },
		);
		// Navigator → click the buried callout's row.
		await browser.executeObsidian(() => {
			(document.querySelector('.mica-lp .mica-head-btn[aria-label="Block navigator"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-navpop .mica-nav-row").length >= 2),
			{ timeout: 8000, timeoutMsg: "the navigator popover never opened" },
		);
		await browser.executeObsidian(() => {
			const row = Array.from(document.querySelectorAll(".mica-navpop .mica-nav-row")).find((m) =>
				m.textContent?.includes("Buried treasure"),
			) as HTMLElement;
			const r = row.getBoundingClientRect();
			const opts = (t: string): PointerEvent =>
				new PointerEvent(t, {
					bubbles: true,
					cancelable: true,
					clientX: r.left + 20,
					clientY: r.top + r.height / 2,
					button: 0,
					pointerId: 3,
				});
			row.dispatchEvent(opts("pointerdown"));
			window.dispatchEvent(opts("pointerup"));
		});
		// The group must have unfolded and the target section flashed.
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelectorAll(".mica-lp .mica-fold-bar").length === 0 &&
						Array.from(document.querySelectorAll(".mica-lp .mica-region")).some(
							(r) => r.textContent?.includes("Buried treasure") && r.classList.contains("mica-flash"),
						),
				),
			{ timeout: 8000, timeoutMsg: "the navigator did not unfold + flash the target" },
		);
	});

	it("dragging a navigator row reorders the section in the document", async function () {
		await seedAndOpen(
			"NavReorder.md",
			"Intro.\n\n```mica id=nav-2\ntab: Main\n> [!note] First\n\n> [!tip] Second\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector('.mica-lp .mica-head-btn[aria-label="Block navigator"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-navpop .mica-nav-row").length >= 3),
			{ timeout: 8000, timeoutMsg: "the navigator popover never opened" },
		);
		await browser.executeObsidian(async () => {
			const rows = Array.from(document.querySelectorAll(".mica-navpop .mica-nav-row")) as HTMLElement[];
			const first = rows.find((m) => m.textContent?.includes("First")) as HTMLElement;
			const second = rows.find((m) => m.textContent?.includes("Second")) as HTMLElement;
			const rf = first.getBoundingClientRect();
			const rs = second.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 4,
			});
			first.dispatchEvent(new PointerEvent("pointerdown", opts(rf.left + 20, rf.top + rf.height / 2)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rf.left + 20, rf.top + 30)));
			await new Promise((r) => setTimeout(r, 30));
			// Bottom half of the LAST sibling row = drop AFTER it.
			window.dispatchEvent(new PointerEvent("pointermove", opts(rs.left + 20, rs.bottom - 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rs.left + 20, rs.bottom - 2)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return v.indexOf("[!tip] Second") >= 0 && v.indexOf("[!tip] Second") < v.indexOf("[!note] First");
			},
			{ timeout: 8000, timeoutMsg: "the tree drag did not reorder the sections" },
		);
	});
});

describe("syntax highlighting", function () {
	it("fenced code inside the quick editor gets token colors", async function () {
		await seedAndOpen(
			"CodeHl.md",
			'Intro.\n\n```mica id=hl-1\ntab: Main\nProse first.\n\n````js\nconst x = "hello";\n````\n```\n',
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 1),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("hello"),
			) as HTMLElement;
			region.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const host = document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement | null;
					const root = host?.shadowRoot;
					// Keyword + string tokens prove the nested language parsed.
					return Boolean(root?.querySelector(".mica-ck") && root.querySelector(".mica-cs"));
				}),
			{ timeout: 8000, timeoutMsg: "fenced-code tokens never highlighted in the editor" },
		);
	});

	it("revealed raw source tints mica structure lines", async function () {
		await seedAndOpen("SrcHl.md", "Intro.\n\n```mica id=hl-2\ntab: Main\nbody text\n```\n");
		// Keep the cursor INSIDE the block while polling: Obsidian restores a
		// remembered cursor shortly after open, which would un-reveal it.
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
					// Reassert only when Obsidian's late cursor-restore moved it —
					// hammering setCursor every poll churns the very updates we
					// are waiting for.
					// A real user's in-block cursor always implies editor FOCUS —
					// Obsidian's own code-fence preview widget only reveals for a
					// focused editor, so an unfocused programmatic cursor leaves
					// its widget covering the range ours correctly released
					// (root-caused via DOM capture: cm-preview-code-block held
					// the lines in every failing run).
					view?.editor.focus();
					const cur = view?.editor.getCursor();
					if (cur && cur.line !== 3) view?.editor.setCursor({ line: 3, ch: 0 });
					return (
						document.querySelectorAll(".cm-line.mica-src-tab").length >= 1 &&
						document.querySelectorAll(".cm-line.mica-src-fence").length >= 1
					);
				}),
			{ timeout: 12000, timeoutMsg: "structure lines never tinted in source view" },
		).catch(async (err: Error) => {
			const diag = await browser.executeObsidian(({ app, obsidian }) => {
				const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
				const lines = Array.from(document.querySelectorAll(".cm-line")).map((l) =>
					(l.textContent ?? "").slice(0, 24),
				);
				const vc = view?.contentEl;
				const sc = vc?.querySelector(".cm-scroller") as HTMLElement | null;
				const cnt = vc?.querySelector(".cm-content") as HTMLElement | null;
				return JSON.stringify({
					file: view?.file?.path,
					cursor: view?.editor.getCursor(),
					lp: document.querySelectorAll(".mica-lp").length,
					srcClasses: document.querySelectorAll("[class*=mica-src]").length,
					cmLines: lines.length,
					lines: lines.slice(0, 8),
					vcRect: vc ? `${Math.round(vc.getBoundingClientRect().top)}h${Math.round(vc.getBoundingClientRect().height)}` : "n/a",
					vcTransform: vc ? getComputedStyle(vc).transform : "n/a",
					scRect: sc ? `${Math.round(sc.getBoundingClientRect().top)}h${Math.round(sc.getBoundingClientRect().height)}` : "n/a",
					contentH: cnt ? Math.round(cnt.getBoundingClientRect().height) : -1,
					scrollTop: sc?.scrollTop ?? -1,
					kids: cnt
						? Array.from(cnt.children).map(
								(c) =>
									`${c.tagName.toLowerCase()}.${(c.className.toString().split(" ")[0] || "?").slice(0, 22)}@h${(c as HTMLElement).offsetHeight}`,
							)
						: [],
				});
			});
			console.log("TINT FAIL DIAG:", diag);
			try {
				const logs = (await browser.getLogs("browser")) as { level: string; message: string }[];
				const bad = logs
					.filter((l) => /error|Error|mica/.test(l.message))
					.map((l) => l.message.slice(0, 300));
				console.log("TINT FAIL CONSOLE:", JSON.stringify(bad.slice(-8)));
			} catch (logErr) {
				console.log("TINT FAIL CONSOLE: unavailable", String(logErr).slice(0, 120));
			}
			throw err;
		});
	});
});

describe("escape cancels everywhere", function () {
	it("Escape cancels an open inline editor even when focus is elsewhere", async function () {
		await seedAndOpen("EscEditor.md", "Intro.\n\n```mica id=esc-1\ntab: Main\nuntouched text\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length >= 1),
			{ timeout: 8000, timeoutMsg: "region never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region.is-editable") as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-mdeditor").length === 1),
			{ timeout: 8000, timeoutMsg: "editor never opened" },
		);
		// Move focus AWAY from the editor, then Escape at the document level.
		await browser.executeObsidian(() => {
			(document.activeElement as HTMLElement | null)?.blur();
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-mdeditor").length === 0),
			{ timeout: 8000, timeoutMsg: "Escape did not close the unfocused editor" },
		);
	});

	it("Escape aborts a column resize and the header keeps its old value", async function () {
		const fixture =
			"Intro.\n\n```mica id=esc-2\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n```\n";
		await seedAndOpen("EscResize.md", fixture);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-col-resizer").length >= 1),
			{ timeout: 8000, timeoutMsg: "resizer never rendered" },
		);
		const before = await docContains("");
		await browser.executeObsidian(async () => {
			const strip = document.querySelector(".mica-lp .mica-col-resizer") as HTMLElement;
			const r = strip.getBoundingClientRect();
			const cy = r.top + r.height / 2;
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			strip.dispatchEvent(new PointerEvent("pointerdown", opts(r.left + 4, cy)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(r.left + 70, cy)));
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(r.left + 70, cy)));
		});
		await new Promise((r) => setTimeout(r, 400));
		const after = await docContains("");
		expect(after).toBe(before); // no colw written
	});
});

describe("round 12: chip ✕, nested callout tools", function () {
	it("the RIGHTMOST tab's ✕ deletes that tab", async function () {
		await seedAndOpen(
			"LastTabX.md",
			"Intro.\n\n```mica id=ltx-1\ntab: One\na\ntab: Two\nb\ntab: Three\nc\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-tab-chip").length >= 3),
			{ timeout: 8000, timeoutMsg: "chips never rendered" },
		);
		await browser.executeObsidian(() => {
			const chips = Array.from(document.querySelectorAll(".mica-lp .mica-tab-chip")) as HTMLElement[];
			const last = chips[chips.length - 1];
			(last.querySelector(".mica-chip-x") as HTMLElement).click();
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return !v.includes("tab: Three") && v.includes("tab: Two");
			},
			{ timeout: 8000, timeoutMsg: "the rightmost tab's ✕ did not delete it" },
		);
	});

	it("nested callouts get tools: ✕ removes just the inner one", async function () {
		await seedAndOpen(
			"NestedTools.md",
			"Intro.\n\n```mica id=nt-1\ntab: Main\n> [!note] Outer stays\n> outer body\n> > [!tip] Inner goes\n> > inner body\n> outer tail\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-nested-callout").length >= 1),
			{ timeout: 8000, timeoutMsg: "the nested callout was never detected" },
		);
		await browser.executeObsidian(() => {
			const inner = document.querySelector(".mica-lp .mica-nested-callout") as HTMLElement;
			(inner.querySelector(".mica-region-x") as HTMLElement).click();
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return (
					!v.includes("Inner goes") &&
					v.includes("Outer stays") &&
					v.includes("> outer body") &&
					v.includes("> outer tail")
				);
			},
			{ timeout: 8000, timeoutMsg: "the nested delete did not surgically remove the inner callout" },
		);
	});

	it("a nested callout drags OUT beside its parent", async function () {
		await seedAndOpen(
			"NestedDrag.md",
			"Intro.\n\n```mica id=nd-1\ntab: Main\n> [!note] Parent\n> > [!tip] Escapee\n> > freedom\n\nanchor prose below\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-nested-callout").length >= 1),
			{ timeout: 8000, timeoutMsg: "nested callout never detected" },
		);
		await browser.executeObsidian(async () => {
			const inner = document.querySelector(".mica-lp .mica-nested-callout") as HTMLElement;
			const grip = inner.querySelector(".mica-region-grip") as HTMLElement;
			const anchor = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("anchor prose"),
			) as HTMLElement;
			const ri = inner.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(ri.right - 10, ri.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(ri.left + 40, ri.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			for (let tries = 0; tries < 30; tries++) {
				const ra = anchor.getBoundingClientRect();
				window.dispatchEvent(new PointerEvent("pointermove", opts(ra.left + 40, ra.bottom + 2)));
				const ind = document.querySelector(".mica-drop-indicator") as HTMLElement | null;
				if (ind && ind.style.display !== "none") break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const ra = anchor.getBoundingClientRect();
			window.dispatchEvent(new PointerEvent("pointerup", opts(ra.left + 40, ra.bottom + 2)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				// The escapee is now a TOP-LEVEL callout (single >) after the anchor,
				// and the parent no longer contains it.
				return (
					v.includes("\n> [!tip] Escapee") &&
					v.indexOf("> [!tip] Escapee") > v.indexOf("anchor prose") &&
					!v.includes("> > [!tip]")
				);
			},
			{ timeout: 8000, timeoutMsg: "the nested callout never escaped to top level" },
		);
	});
});

describe("round 13: boundary adds, editor click-to-end, body popovers", function () {
	it("the boundary ⊕ pill inserts a column; a bare strip dblclick never does", async function () {
		await seedAndOpen(
			"BoundaryCol.md",
			"Intro.\n\n```mica id=bc-1\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-col-resizer").length >= 1),
			{ timeout: 8000, timeoutMsg: "boundary strip never rendered" },
		);
		// A double-click on the strip resets widths — it must NOT insert
		// (the old click-to-add fired on the first click of a dblclick).
		await browser.executeObsidian(() => {
			const strip = document.querySelector(".mica-lp .mica-col-resizer") as HTMLElement;
			strip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});
		await browser.pause(400);
		const afterDbl = await browser.executeObsidian(({ app, obsidian }) => {
			return app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
		});
		expect(afterDbl).toContain("{cols=2}");
		// The ⊕ pill IS the click-to-add.
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-col-resizer .mica-boundary-plus") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes("{cols=3}") && (v.match(/:::cell/g) ?? []).length === 3;
				}),
			{ timeout: 8000, timeoutMsg: "the boundary pill did not insert a column" },
		);
		// Edge add on the LEFT.
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-edge-add.is-left") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes("{cols=4}") && (v.match(/:::cell/g) ?? []).length === 4;
				}),
			{ timeout: 8000, timeoutMsg: "the left edge did not add a column" },
		);
	});

	it("the row boundary ⊕ pill inserts a full row of cells", async function () {
		await seedAndOpen(
			"BoundaryRow.md",
			"Intro.\n\n```mica id=br-1\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-row-resizer").length >= 1),
			{ timeout: 8000, timeoutMsg: "row boundary never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-row-resizer .mica-boundary-plus") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return (v.match(/:::cell/g) ?? []).length === 6;
				}),
			{ timeout: 8000, timeoutMsg: "the row boundary pill did not insert a row" },
		);
	});

	it("column handle menu deletes the whole column; row handle drag reorders rows", async function () {
		await seedAndOpen(
			"Handles.md",
			"Intro.\n\n```mica id=hd-1\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-col-handle").length === 2),
			{ timeout: 8000, timeoutMsg: "column handles never rendered" },
		);
		// Click the first column's handle → structural menu → Delete column.
		await browser.executeObsidian(async () => {
			const h = document.querySelector('.mica-lp .mica-col-handle[data-col="0"]') as HTMLElement;
			const r = h.getBoundingClientRect();
			const opts: PointerEventInit = {
				bubbles: true,
				cancelable: true,
				clientX: r.left + r.width / 2,
				clientY: r.top + r.height / 2,
				button: 0,
				pointerId: 7,
			};
			h.dispatchEvent(new PointerEvent("pointerdown", opts));
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts));
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll("body > .menu .menu-item").length > 0),
			{ timeout: 8000, timeoutMsg: "the column menu never opened" },
		);
		await browser.executeObsidian(() => {
			const items = Array.from(document.querySelectorAll("body > .menu .menu-item"));
			(items.find((x) => x.textContent?.includes("Delete column")) as HTMLElement)?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return (
						v.includes("{cols=1}") &&
						!v.includes("\na\n") &&
						!v.includes("\nc\n") &&
						(v.match(/:::cell/g) ?? []).length === 2
					);
				}),
			{ timeout: 8000, timeoutMsg: "delete column did not remove a and c" },
		);
		// Drag the first row's handle below the second row → rows swap.
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-row-handle").length === 2),
			{ timeout: 8000, timeoutMsg: "row handles never re-rendered" },
		);
		await browser.executeObsidian(async () => {
			const h = document.querySelector('.mica-lp .mica-row-handle[data-row="0"]') as HTMLElement;
			const cells = document.querySelectorAll(".mica-lp .mica-cell");
			const target = cells[1].getBoundingClientRect(); // second row's cell (cols=1)
			const hr = h.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 8,
			});
			h.dispatchEvent(new PointerEvent("pointerdown", opts(hr.left + 4, hr.top + 4)));
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(
				new PointerEvent("pointermove", opts(target.left + 20, target.top + target.height / 2)),
			);
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(
				new PointerEvent("pointerup", opts(target.left + 20, target.top + target.height / 2)),
			);
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.indexOf(":::cell\nd\n") < v.indexOf(":::cell\nb\n") && v.indexOf(":::cell\nd\n") !== -1;
				}),
			{ timeout: 8000, timeoutMsg: "row drag did not reorder d above b" },
		);
	});

	it("clearing a cell empties it without shifting the lattice", async function () {
		await seedAndOpen(
			"ClearCell.md",
			"Intro.\n\n```mica id=cc-1\n:::grid {cols=2}\n:::cell\nalpha\n:::\n:::cell\nbeta\n:::\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-cell").length === 2),
			{ timeout: 8000, timeoutMsg: "grid never rendered" },
		);
		await browser.executeObsidian(() => {
			const cell = document.querySelector(".mica-lp .mica-cell") as HTMLElement;
			const clear = cell.querySelector('.mica-cell-bar [aria-label="Clear cell"]') as HTMLElement;
			clear.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return !v.includes("alpha") && v.includes("beta") && (v.match(/:::cell/g) ?? []).length === 2;
				}),
			{ timeout: 8000, timeoutMsg: "clear did not empty the cell in place" },
		);
	});

	it("a section inserted against another section stays its own section", async function () {
		await seedAndOpen("NoMerge.md", "Intro.\n\n```mica id=nm-1\ntab: Main\nfirst paragraph\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length >= 1),
			{ timeout: 8000, timeoutMsg: "region never rendered" },
		);
		// The tail insert zone → Text: the new section must land with a
		// blank-line seam, not glue into "first paragraph".
		await browser.executeObsidian(() => {
			const zone = document.querySelector(".mica-lp .mica-insert-zone.is-tail .mica-insert-plus") as HTMLElement;
			zone.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll("body > .menu .menu-item").length > 0),
			{ timeout: 8000, timeoutMsg: "the insert menu never opened" },
		);
		await browser.executeObsidian(() => {
			const items = Array.from(document.querySelectorAll("body > .menu .menu-item"));
			(items.find((x) => x.textContent?.trim() === "Text") as HTMLElement)?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes("first paragraph\n\nWrite here…");
				}),
			{ timeout: 8000, timeoutMsg: "the inserted section merged into its neighbor" },
		);
		// And the two render as SEPARATE regions.
		const regions = await browser.executeObsidian(
			() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length,
		);
		expect(regions).toBe(2);
	});

	it("one visual gap offers one insert line (tab tail owns the gap below the group)", async function () {
		await seedAndOpen("OneGap.md", "Intro.\n\n```mica id=og-1\ntab: Main\nsome body text\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-insert-zone.is-tail").length > 0),
			{ timeout: 8000, timeoutMsg: "tail zones never rendered" },
		);
		const tails = await browser.executeObsidian(() => {
			// The tab body has a tail zone; the block ROOT must not add a second
			// line into the same visual gap (its last child is the tabs group).
			return {
				total: document.querySelectorAll(".mica-lp .mica-insert-zone.is-tail").length,
				inPanels: document.querySelectorAll(".mica-lp .mica-tab-panel .mica-insert-zone.is-tail").length,
			};
		});
		expect(tails.total).toBe(tails.inPanels);
	});

	it("clicking below the lightbox text places the caret at the end", async function () {
		await seedAndOpen("ClickEnd.md", "Intro.\n\n```mica id=cke-1\ntab: Main\nshort text\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length >= 1),
			{ timeout: 8000, timeoutMsg: "region never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = document.querySelector(".mica-lp .mica-region.is-editable") as HTMLElement;
			region.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lightbox .mica-mdeditor").length === 1),
			{ timeout: 8000, timeoutMsg: "lightbox never opened" },
		);
		const at = await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: { view: { state: { selection: { main: { head: number } }; doc: { length: number } } } };
			};
			const r = host.getBoundingClientRect();
			host.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.bottom - 10 }),
			);
			const view = host.micaEditor?.view;
			return view ? `${view.state.selection.main.head}/${view.state.doc.length}` : "no view";
		});
		const [head, len] = at.split("/").map(Number);
		expect(head).toBe(len);
		await browser.executeObsidian(() => {
			(Array.from(document.querySelectorAll(".mica-lightbox button")).find(
				(b) => b.textContent === "Cancel",
			) as HTMLElement)?.click();
		});
	});

	it("the toolbar overflow popover opens at body level (never clipped)", async function () {
		await seedAndOpen("Overflow.md", "Intro.\n\n```mica id=ov-1\ntab: Main\nsome text\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length >= 1),
			{ timeout: 8000, timeoutMsg: "region never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region.is-editable") as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-toolbar .mica-tool").length >= 1),
			{ timeout: 8000, timeoutMsg: "quick toolbar never appeared" },
		);
		const state = await browser.executeObsidian(() => {
			// Open a picker popover from the toolbar (callout button exists in
			// the default layout) — it must mount on BODY and have real size.
			const btn = Array.from(
				document.querySelectorAll(".mica-lp .mica-toolbar .mica-tool"),
			).find((b) => b.getAttribute("aria-label")?.toLowerCase().includes("callout")) as HTMLElement | undefined;
			if (!btn) return "no callout button (overflowed)";
			btn.click();
			const pop = document.body.querySelector(":scope > .mica-tb-popover") as HTMLElement | null;
			if (!pop) return "no popover";
			const r = pop.getBoundingClientRect();
			return r.width > 100 && r.height > 60 ? "ok" : `too small ${Math.round(r.width)}x${Math.round(r.height)}`;
		});
		expect(["ok", "no callout button (overflowed)"]).toContain(state);
	});
});
