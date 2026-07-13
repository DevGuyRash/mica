import { MarkdownRenderChild, MarkdownRenderer, Modal, setIcon, type App } from "obsidian";
import { MdEditor } from "./mdEditor";
import { buildToolbar } from "./toolbarView";

export interface LightboxOpts {
	app: App;
	title: string;
	initial: string;
	sourcePath: string;
	/** Called with the edited markdown on an explicit save. */
	onSave: (value: string) => void;
	/** Optional: called when the box closes without saving. */
	onDiscard?: () => void;
	/** Live draft mirror (keeps quick-edit drafts in sync while typing here). */
	onDraft?: (value: string) => void;
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

	constructor(private readonly opts: LightboxOpts) {
		super(opts.app);
	}

	onOpen(): void {
		this.modalEl.addClass("mica-lightbox");
		this.titleEl.setText(this.opts.title);

		const root = this.contentEl.createDiv({ cls: "mica-lightbox-root" });
		const toolbarRow = root.createDiv({ cls: "mica-lightbox-toolbar" });
		const split = root.createDiv({ cls: "mica-lightbox-split" });
		const editorHost = split.createDiv({ cls: "mica-lightbox-editor" });
		this.previewEl = split.createDiv({ cls: "mica-lightbox-preview" });

		this.editor = new MdEditor(editorHost, {
			initial: this.opts.initial,
			placeholder: "Write markdown — Ctrl/Cmd+Enter saves, Esc cancels",
			onSave: () => this.save(),
			onCancel: () => this.requestClose(),
			onChange: (v) => {
				this.disarmDiscard();
				this.opts.onDraft?.(v);
				this.refreshStats(v);
				this.schedulePreview();
			},
			onSelection: () => this.refreshStats(this.editor?.getValue() ?? ""),
		});

		buildToolbar(toolbarRow, this.opts.app, () => this.editor!.view, false);

		// Right side of the toolbar: preview toggle.
		const spacer = toolbarRow.createDiv({ cls: "mica-toolbar-spacer" });
		void spacer;
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
		const hint = footer.createSpan({ cls: "mica-lightbox-hint", text: "Ctrl+Enter to save" });
		void hint;
		this.cancelBtn = footer.createEl("button", { text: "Cancel", attr: { type: "button" } });
		this.cancelBtn.addEventListener("click", () => this.requestClose());
		const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } });
		saveBtn.addEventListener("click", () => this.save());

		// Esc goes through OUR dirty check, not straight to Modal.close().
		this.scope.register([], "Escape", () => {
			this.requestClose();
			return false;
		});
	}

	private get dirty(): boolean {
		return (this.editor?.getValue() ?? this.opts.initial) !== this.opts.initial;
	}

	private save(): void {
		if (!this.editor) return;
		this.saved = true;
		const value = this.editor.getValue();
		this.close();
		this.opts.onSave(value);
	}

	/** Esc / Cancel: close clean editors instantly; arm a confirm when dirty. */
	private requestClose(): void {
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
			this.editor.getValue(),
			this.previewEl.createDiv({ cls: "mica-md-inner" }),
			this.opts.sourcePath,
			child,
		);
	}

	onClose(): void {
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewChild?.unload();
		this.editor?.destroy();
		this.editor = null;
		if (!this.saved) this.opts.onDiscard?.();
		this.contentEl.empty();
	}
}
