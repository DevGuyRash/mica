import { MarkdownRenderChild, MarkdownRenderer, Modal, setIcon, type App } from "obsidian";
import { editorViewPrefs, MdEditor, toggleViewPref, saveShortcutLabel } from "./mdEditor";
import { buildToolbar } from "./toolbarView";

export interface LightboxOpts {
	app: App;
	title: string;
	initial: string;
	sourcePath: string;
	/** Called with the edited markdown on an explicit save. */
	/** Return false to keep the editor open (for example, a stale pre-image). */
	onSave: (value: string) => boolean | void | Promise<boolean | void>;
	/** Optional: called when the box closes without saving. */
	onDiscard?: () => void;
	/** Live draft mirror (keeps quick-edit drafts in sync while typing here). */
	onDraft?: (value: string) => void;
	/** Optional derivative hook: inject field rows ABOVE the editor. `refresh`
	 *  re-renders the live preview (call it when a field changes). */
	header?: (host: HTMLElement, refresh: () => void) => void | (() => void);
	/** Derivative editors can include header fields in their dirty contract. */
	isDirty?: (body: string) => boolean;
	/** Optional derivative hook: what the preview (and only the preview)
	 *  renders — e.g. the assembled callout around the edited body. */
	previewTransform?: (body: string) => string;
}

/**
 * The dedicated editor lightbox: a near-full-screen markdown editor with the
 * full toolbar, a live preview pane, word count, and an explicit save
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

	constructor(private readonly opts: LightboxOpts) {
		super(opts.app);
	}

	onOpen(): void {
		this.modalEl.addClass("mica-lightbox");
		this.titleEl.setText(this.opts.title);

		const root = this.contentEl.createDiv({ cls: "mica-lightbox-root" });
		if (this.opts.header) {
			const head = root.createDiv({ cls: "mica-lightbox-fields" });
			this.destroyHeader =
				this.opts.header(head, () => {
					this.disarmDiscard();
					if (this.previewOn) this.renderPreview();
				}) ?? null;
		}
		const toolbarRow = root.createDiv({ cls: "mica-lightbox-toolbar" });
		const split = root.createDiv({ cls: "mica-lightbox-split" });
		const editorHost = split.createDiv({ cls: "mica-lightbox-editor" });
		this.previewEl = split.createDiv({ cls: "mica-lightbox-preview" });

		const shortcut = saveShortcutLabel();
		this.editor = new MdEditor(editorHost, {
			app: this.opts.app,
			initial: this.opts.initial,
			placeholder: shortcut ? `Write markdown — ${shortcut} saves, Esc cancels` : "Write markdown — Esc cancels",
			onSave: () => void this.save(),
			onCancel: () => this.requestClose(),
			onChange: (v) => {
				this.disarmDiscard();
				this.opts.onDraft?.(v);
				this.refreshStats(v);
				this.schedulePreview();
			},
			onSelection: () => this.refreshStats(this.editor?.getValue() ?? ""),
		});

		this.destroyToolbar = buildToolbar(toolbarRow, this.opts.app, () => this.editor!.view, false);

		// Right side of the toolbar: view toggles + preview.
		const spacer = toolbarRow.createDiv({ cls: "mica-toolbar-spacer" });
		void spacer;
		const viewToggle = (icon: string, label: string, get: () => boolean, flip: () => void): void => {
			const b = toolbarRow.createEl("button", {
				cls: `clickable-icon mica-tool ${get() ? "is-on" : ""}`,
				attr: { type: "button", "aria-label": label },
			});
			setIcon(b, icon);
			b.addEventListener("click", () => {
				flip();
				b.toggleClass("is-on", get());
			});
		};
		viewToggle(
			"list-ordered",
			"Line numbers",
			() => editorViewPrefs().lineNumbers,
			() => toggleViewPref("lineNumbers"),
		);
		viewToggle(
			"pilcrow",
			"Show whitespace characters",
			() => editorViewPrefs().whitespace,
			() => toggleViewPref("whitespace"),
		);
		const previewBtn = toolbarRow.createEl("button", {
			cls: "clickable-icon mica-tool mica-tool-preview",
			attr: { type: "button", "aria-label": "Toggle live preview pane" },
		});
		setIcon(previewBtn, "eye");
		previewBtn.addEventListener("click", () => {
			this.previewOn = !this.previewOn;
			previewBtn.toggleClass("is-on", this.previewOn);
			split.toggleClass("is-split", this.previewOn);
			if (this.previewOn) this.renderPreview();
		});

		// Footer: stats + actions.
		const footer = root.createDiv({ cls: "mica-lightbox-footer" });
		this.statsEl = footer.createDiv({ cls: "mica-lightbox-stats" });
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
		this.scope.register([], "Escape", () => {
			this.requestClose();
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
		// Escape aimed at a popover INSIDE the lightbox (the callout type
		// grid, a toolbar picker) dismisses that popover — it must never arm
		// "Discard changes?" on the whole editor.
		const pop = this.contentEl.querySelector(".mica-popover") as (HTMLElement & { micaClose?: () => void }) | null;
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
		window.setTimeout(() => this.disarmDiscard(), 2500);
	}

	private disarmDiscard(): void {
		if (!this.discardArmed) return;
		this.discardArmed = false;
		this.cancelBtn?.removeClass("mica-danger");
		this.cancelBtn?.setText("Cancel");
	}

	/** Real words (letter/number runs; "don't" is one, "##" is none). */
	private static words(text: string): number {
		return (text.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu) ?? []).length;
	}

	private refreshStats(value: string): void {
		if (!this.statsEl) return;
		const words = EditorLightbox.words(value);
		const lines = value.length ? value.split("\n").length : 0;
		const sel = this.editor?.view.state.selection.main;
		if (sel && !sel.empty) {
			const chosen = this.editor?.view.state.sliceDoc(sel.from, sel.to) ?? "";
			this.statsEl.setText(
				`${EditorLightbox.words(chosen)} / ${words} words · ${chosen.length} / ${value.length} chars · ${lines} lines`,
			);
			return;
		}
		this.statsEl.setText(`${words} words · ${value.length} chars · ${lines} lines`);
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
		this.previewChild?.unload();
		this.destroyHeader?.();
		this.destroyHeader = null;
		this.destroyToolbar?.();
		this.destroyToolbar = null;
		this.editor?.destroy();
		this.editor = null;
		if (!this.saved) this.opts.onDiscard?.();
		this.contentEl.empty();
	}
}
