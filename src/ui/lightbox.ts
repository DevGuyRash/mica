import { MarkdownRenderChild, MarkdownRenderer, Menu, Modal, Scope, setIcon, type App } from "obsidian";
import { editorViewPrefs, type EditorLanguage, MdEditor, toggleViewPref, saveShortcutLabel } from "./mdEditor";
import { buildToolbar } from "./toolbarView";
import { LightboxSearch } from "./lightboxSearch";
import { sourceTextDetails, visibleTextStats, type VisibleTextStats } from "./textStats";
import type { ActionSpec } from "./actionMenu";
import { mountResponsiveActionStrip } from "./responsiveActionStrip";

export interface LightboxOpts {
	app: App;
	title: string;
	initial: string;
	sourcePath: string;
	/** Body syntax for the shared editor. Defaults to Markdown. */
	editorLanguage?: EditorLanguage;
	/** Preserve the enclosing source's line ending when the body starts empty. */
	editorLineSeparator?: "\n" | "\r\n";
	/** Called with the edited markdown on an explicit save. */
	/** Return false to keep the editor open (for example, a stale pre-image). */
	onSave: (value: string) => boolean | void | Promise<boolean | void>;
	/** Optional: called when the box closes without saving. */
	onDiscard?: () => void;
	/** Live draft mirror (keeps quick-edit drafts in sync while typing here). */
	onDraft?: (value: string) => void;
	/** Optional derivative hook: inject field rows ABOVE the editor. `refresh`
	 *  re-renders the live preview (call it when a field changes). */
	header?: (
		host: HTMLElement,
		refresh: () => void,
		setEditorLanguage: (language: EditorLanguage) => void,
	) => void | (() => void);
	/** Derivative editors can include header fields in their dirty contract. */
	isDirty?: (body: string) => boolean;
	/** Optional derivative hook: what the preview (and only the preview)
	 *  renders — e.g. the assembled callout around the edited body. */
	previewTransform?: (body: string) => string;
}

/**
 * The dedicated editor lightbox: a near-full-screen shared editor with the
 * relevant toolbar, a live preview pane, word count, and an explicit save
 * lifecycle. Esc with unsaved changes arms a "press again to discard" state
 * instead of silently dropping work; nothing ever commits on blur.
 */
export class EditorLightbox extends Modal {
	private editor: MdEditor | null = null;
	private previewOn = false;
	private previewEl: HTMLElement | null = null;
	private previewChild: MarkdownRenderChild | null = null;
	private statsEl: HTMLElement | null = null;
	private cancelBtn: HTMLButtonElement | null = null;
	private discardArmed = false;
	private saved = false;
	private previewTimer: number | null = null;
	private destroyToolbar: (() => void) | null = null;
	private destroyHeader: (() => void) | null = null;
	private search: LightboxSearch | null = null;
	private removePrefsListener: (() => void) | null = null;
	private destroyActionMenu: (() => void) | null = null;
	private actionMenuIsOpen: (() => boolean) | null = null;
	private closeActionMenu: (() => void) | null = null;
	private popSearchScope: (() => void) | null = null;
	private statsTimer: number | null = null;
	private statsValue = "";
	private statsComputedValue: string | null = null;
	private totalStats: VisibleTextStats = { words: 0, characters: 0, lines: 0 };
	private discardTimer: number | null = null;
	private currentLanguage: EditorLanguage;
	private statsMenu: Menu | null = null;

	constructor(private readonly opts: LightboxOpts) {
		super(opts.app);
		this.currentLanguage = opts.editorLanguage ?? { kind: "markdown" };
	}

	onOpen(): void {
		this.modalEl.addClass("mica-lightbox");
		this.titleEl.setText(this.opts.title);

		const root = this.contentEl.createDiv({ cls: "mica-lightbox-root" });
		const head = this.opts.header ? root.createDiv({ cls: "mica-lightbox-fields" }) : null;
		const toolbarRow = root.createDiv({ cls: "mica-lightbox-toolbar" });
		const searchHost = root.createDiv();
		const split = root.createDiv({ cls: "mica-lightbox-split" });
		const editorHost = split.createDiv({ cls: "mica-lightbox-editor" });
		this.previewEl = split.createDiv({ cls: "mica-lightbox-preview" });

		const shortcut = saveShortcutLabel();
		this.editor = new MdEditor(editorHost, {
			app: this.opts.app,
			initial: this.opts.initial,
			language: this.opts.editorLanguage,
			lineSeparator: this.opts.editorLineSeparator,
			placeholder:
				this.opts.editorLanguage?.kind === "code"
					? shortcut
						? `Write code — ${shortcut} saves, Esc cancels`
						: "Write code — Esc cancels"
					: shortcut
						? `Write markdown — ${shortcut} saves, Esc cancels`
						: "Write markdown — Esc cancels",
			onSave: () => void this.save(),
			onCancel: () => this.requestClose(),
			onChange: (v) => {
				this.disarmDiscard();
				this.opts.onDraft?.(v);
				this.search?.onDocumentChanged();
				this.scheduleStats(v);
				this.schedulePreview();
			},
			onSelection: () => this.scheduleStats(this.editor?.getValue() ?? "", 60),
		});
		// The modal's built-in Escape binding and Mica's dirty-close binding share
		// one Scope. A child scope while search is visible makes “close search” the
		// only Escape action, instead of letting one keystroke reach both handlers.
		const findScope = new Scope(this.scope);
		let findScopePushed = false;
		const setFindScope = (open: boolean): void => {
			if (open && !findScopePushed) {
				this.opts.app.keymap.pushScope(findScope);
				findScopePushed = true;
			} else if (!open && findScopePushed) {
				this.opts.app.keymap.popScope(findScope);
				findScopePushed = false;
			}
		};
		findScope.register([], "Escape", (event) => {
			event.stopImmediatePropagation();
			this.search?.close();
			return false;
		});
		this.popSearchScope = () => setFindScope(false);
		this.search = new LightboxSearch(searchHost, this.editor, setFindScope);
		let refreshEditorActions = (): void => undefined;
		if (head && this.opts.header) {
			this.destroyHeader =
				this.opts.header(
					head,
					() => {
						this.disarmDiscard();
						if (this.previewOn) this.renderPreview();
					},
					(language) => {
						this.currentLanguage = language;
						this.editor?.setLanguage(language);
						refreshEditorActions();
					},
				) ?? null;
		}

		this.destroyToolbar = buildToolbar(
			toolbarRow,
			this.opts.app,
			() => this.editor!.view,
			false,
			this.opts.editorLanguage?.kind === "code" ? "code" : "markdown",
		);

		// Right side of the toolbar: view toggles + preview.
		const spacer = toolbarRow.createDiv({ cls: "mica-toolbar-spacer" });
		void spacer;
		const lineBtn = toolbarRow.createEl("button", {
			cls: `clickable-icon mica-tool mica-tool-lines ${editorViewPrefs().lineNumbers ? "is-on" : ""}`,
			attr: {
				type: "button",
				"aria-label": "Line numbers",
				"aria-pressed": String(editorViewPrefs().lineNumbers),
			},
		});
		setIcon(lineBtn, "list-ordered");
		const paintLineButton = (): void => {
			const on = editorViewPrefs().lineNumbers;
			lineBtn.toggleClass("is-on", on);
			lineBtn.setAttribute("aria-pressed", String(on));
			refreshEditorActions();
		};
		lineBtn.addEventListener("click", () => {
			toggleViewPref("lineNumbers");
			paintLineButton();
		});
		document.addEventListener("mica-editor-prefs-change", paintLineButton);
		this.removePrefsListener = () => document.removeEventListener("mica-editor-prefs-change", paintLineButton);

		const toolbarMount = toolbarRow.querySelector<HTMLElement>(".mica-toolbar-mount");
		const actionMenu = mountResponsiveActionStrip(
			toolbarRow,
			() =>
				[
					{
						id: "find",
						label: "Find and replace",
						icon: "search",
						directPriority: 0,
						run: () => this.search?.open(),
					},
					{
						id: "whitespace",
						label: "Show whitespace",
						icon: "pilcrow",
						checked: editorViewPrefs().whitespace,
						directPriority: 1,
						run: () => toggleViewPref("whitespace"),
					},
					{
						id: "syntax",
						label: "Style Markdown source",
						icon: "wand-sparkles",
						checked: editorViewPrefs().liveSyntax,
						directPriority: 3,
						disabled:
							this.currentLanguage.kind === "code" &&
							!["md", "markdown"].includes(
								this.currentLanguage.info
									.trimStart()
									.match(/^[^\s]+/)?.[0]
									?.toLocaleLowerCase() ?? "",
							),
						run: () => toggleViewPref("liveSyntax"),
					},
					{
						id: "preview",
						label: "Live preview",
						icon: "eye",
						checked: this.previewOn,
						directPriority: 2,
						run: () => {
							this.previewOn = !this.previewOn;
							split.toggleClass("is-split", this.previewOn);
							if (this.previewOn) this.renderPreview();
							refreshEditorActions();
						},
					},
				] satisfies ActionSpec[],
			{
				app: this.opts.app,
				source: toolbarRow,
				label: "Editor actions",
				className: "mica-editor-actions",
				buttonClass: "mica-tool",
				menuClass: "mica-tool mica-editor-menu",
				preserveFocus: true,
				reservedWidth: () => lineBtn.offsetWidth + (toolbarMount?.childElementCount ? 70 : 0) + 16,
			},
		);
		refreshEditorActions = actionMenu.refresh;
		this.destroyActionMenu = actionMenu.destroy;
		this.actionMenuIsOpen = actionMenu.isOpen;
		this.closeActionMenu = actionMenu.close;

		// Footer: stats + actions.
		const footer = root.createDiv({ cls: "mica-lightbox-footer" });
		this.statsEl = footer.createEl("button", {
			cls: "mica-lightbox-stats",
			attr: { type: "button", "aria-label": "Text statistics and source details" },
		});
		this.statsEl.addEventListener("click", (event) => this.showSourceStats(event));
		this.refreshStats(this.opts.initial);
		footer.createDiv({ cls: "mica-footer-spacer" });
		const hintLabel = saveShortcutLabel();
		const hint = footer.createSpan({
			cls: "mica-lightbox-hint",
			text: hintLabel ? `${hintLabel} to save` : "Save with the button",
		});
		void hint;
		this.cancelBtn = footer.createEl("button", { text: "Cancel", attr: { type: "button" } });
		this.cancelBtn.addEventListener("click", () => this.requestClose());
		const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } });
		saveBtn.addEventListener("click", () => void this.save());

		// Esc goes through OUR dirty check, not straight to Modal.close().
		this.scope.register([], "Escape", (event) => {
			// Obsidian's Modal also owns an Escape listener. Stop this key event at
			// the scoped handler so closing the find ribbon cannot fall through to
			// the modal's unconditional close path in the same dispatch.
			event.stopImmediatePropagation();
			if (this.search?.isOpen) {
				this.search.close();
				return false;
			}
			this.requestClose();
			return false;
		});
		this.scope.register(["Mod"], "f", () => {
			this.search?.open();
			return false;
		});
	}

	private get dirty(): boolean {
		const value = this.editor?.getValue() ?? this.opts.initial;
		return this.opts.isDirty?.(value) ?? value !== this.opts.initial;
	}

	private async save(): Promise<void> {
		if (!this.editor) return;
		const value = this.editor.getValue();
		const accepted = await this.opts.onSave(value);
		if (accepted === false) return;
		this.saved = true;
		this.close();
	}

	/** Esc / Cancel: close clean editors instantly; arm a confirm when dirty. */
	private requestClose(): void {
		if (this.actionMenuIsOpen?.()) {
			this.closeActionMenu?.();
			return;
		}
		// Escape aimed at a popover INSIDE the lightbox (the callout type
		// grid, a toolbar picker) dismisses that popover — it must never arm
		// "Discard changes?" on the whole editor.
		const pop = this.contentEl.querySelector<HTMLElement & { micaClose?: () => void }>(".mica-popover");
		if (pop) {
			if (pop.micaClose) pop.micaClose();
			else pop.remove();
			return;
		}
		if (!this.dirty || this.discardArmed) {
			this.close();
			return;
		}
		this.discardArmed = true;
		this.cancelBtn?.addClass("mica-danger");
		this.cancelBtn?.setText("Discard changes?");
		if (this.discardTimer !== null) window.clearTimeout(this.discardTimer);
		this.discardTimer = window.setTimeout(() => this.disarmDiscard(), 2500);
	}

	private disarmDiscard(): void {
		if (this.discardTimer !== null) window.clearTimeout(this.discardTimer);
		this.discardTimer = null;
		if (!this.discardArmed) return;
		this.discardArmed = false;
		this.cancelBtn?.removeClass("mica-danger");
		this.cancelBtn?.setText("Cancel");
	}

	private scheduleStats(value: string, delay = 120): void {
		this.statsValue = value;
		if (this.statsTimer !== null) window.clearTimeout(this.statsTimer);
		this.statsTimer = window.setTimeout(() => {
			this.statsTimer = null;
			this.refreshStats(this.statsValue);
		}, delay);
	}

	private refreshStats(value: string): void {
		if (!this.statsEl) return;
		if (value !== this.statsComputedValue) {
			this.statsValue = value;
			this.statsComputedValue = value;
			this.totalStats = visibleTextStats(value);
		}
		const total = this.totalStats;
		const sel = this.editor?.view.state.selection.main;
		if (sel && !sel.empty) {
			const chosen = this.editor?.view.state.sliceDoc(sel.from, sel.to) ?? "";
			const selected = visibleTextStats(chosen);
			this.statsEl.setText(
				`${selected.words} / ${total.words} words · ${selected.characters} / ${total.characters} chars · ${selected.lines} / ${total.lines} lines`,
			);
			return;
		}
		this.statsEl.setText(`${total.words} words · ${total.characters} chars · ${total.lines} lines`);
	}

	private showSourceStats(event: MouseEvent): void {
		const stats = sourceTextDetails(this.editor?.getValue() ?? this.opts.initial);
		this.statsMenu?.hide();
		const menu = new Menu();
		this.statsMenu = menu;
		menu.onHide(() => {
			if (this.statsMenu === menu) this.statsMenu = null;
		});
		menu.addItem((item) => item.setTitle(`${stats.sourceUnits} UTF-16 units`).setDisabled(true));
		menu.addItem((item) => item.setTitle(`${stats.utf8Bytes} UTF-8 bytes`).setDisabled(true));
		menu.addItem((item) => item.setTitle(`${stats.rawLines} raw lines`).setDisabled(true));
		menu.addItem((item) => item.setTitle(`${stats.lineEndings} line endings`).setDisabled(true));
		menu.showAtMouseEvent(event);
	}

	private schedulePreview(): void {
		if (!this.previewOn) return;
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = window.setTimeout(() => this.renderPreview(), 250);
	}

	private renderPreview(): void {
		if (!this.previewEl || !this.editor) return;
		this.previewEl.empty();
		this.previewChild?.unload();
		const child = new MarkdownRenderChild(this.previewEl);
		this.previewChild = child;
		child.load();
		void MarkdownRenderer.render(
			this.opts.app,
			this.opts.previewTransform?.(this.editor.getValue()) ?? this.editor.getValue(),
			this.previewEl.createDiv({ cls: "mica-md-inner" }),
			this.opts.sourcePath,
			child,
		);
	}

	onClose(): void {
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		if (this.statsTimer !== null) window.clearTimeout(this.statsTimer);
		this.disarmDiscard();
		this.statsMenu?.hide();
		this.statsMenu = null;
		this.previewChild?.unload();
		this.destroyHeader?.();
		this.destroyHeader = null;
		this.destroyToolbar?.();
		this.destroyToolbar = null;
		this.destroyActionMenu?.();
		this.destroyActionMenu = null;
		this.actionMenuIsOpen = null;
		this.closeActionMenu = null;
		this.removePrefsListener?.();
		this.removePrefsListener = null;
		this.search?.destroy();
		this.search = null;
		this.popSearchScope?.();
		this.popSearchScope = null;
		this.editor?.destroy();
		this.editor = null;
		if (!this.saved) this.opts.onDiscard?.();
		this.contentEl.empty();
	}
}
