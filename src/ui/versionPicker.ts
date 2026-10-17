import { Modal, Notice, SuggestModal, type App } from "obsidian";
import {
	buildVersionSearchIndex,
	searchVersionIndex,
	type VersionLookupRow,
	type VersionSearchIndexEntry,
} from "./versionWindow";

const RESULT_LIMIT = 100;

export interface VersionPickerOptions<T extends VersionLookupRow> {
	app: App;
	rows: readonly T[];
	title?: string;
	selectedKey?: string;
	baseKey?: string;
	onChoose: (row: T) => Promise<boolean>;
}

/**
 * Searchable, keyboard-complete version lookup.
 *
 * Built on Obsidian's own `SuggestModal` rather than a hand-rolled list. The
 * previous version rendered each result as a `<button>`, which any theme that
 * styles buttons as filled accent controls turned into a wall of solid blocks —
 * Mica's `background: transparent` lost on specificity, and no amount of
 * defensive CSS wins that fight for every theme a user might install. Native
 * suggestion markup inherits whatever the theme does to the quick switcher, and
 * brings keyboard navigation, scrolling and accessibility with it.
 */
export class VersionPickerModal<T extends VersionLookupRow> extends SuggestModal<T> {
	private choosing = false;
	private closed = false;
	private readonly searchIndex: VersionSearchIndexEntry<T>[];

	constructor(private readonly options: VersionPickerOptions<T>) {
		super(options.app);
		this.searchIndex = buildVersionSearchIndex(options.rows);
		this.limit = RESULT_LIMIT;
		this.modalEl.addClass("mica-version-picker");
		this.setPlaceholder(options.title ?? "Version number, checkpoint ID, label, hash, or date");
		this.emptyStateText = "No matching versions";
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "use as comparison base" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	getSuggestions(query: string): T[] {
		return searchVersionIndex(this.searchIndex, query, RESULT_LIMIT).results.map((result) => result.row);
	}

	renderSuggestion(row: T, el: HTMLElement): void {
		el.addClass("mica-version-suggestion");
		const title = el.createDiv({ cls: "mica-version-suggestion-title" });
		title.createSpan({ cls: "mica-version-suggestion-number", text: `v${row.n}` });
		if (row.meta.label) title.createSpan({ cls: "mica-version-suggestion-label", text: row.meta.label });
		const badges = title.createSpan({ cls: "mica-version-suggestion-badges" });
		if (row.head) badges.createSpan({ text: "Head" });
		if (row.meta.versionId === this.options.selectedKey) badges.createSpan({ text: "Selected" });
		if (row.meta.versionId === this.options.baseKey) badges.createSpan({ text: "Base" });
		const detail = el.createDiv({ cls: "mica-version-suggestion-detail" });
		if (row.meta.ts)
			detail.createEl("time", {
				text: new Date(row.meta.ts).toLocaleString(),
				attr: { datetime: new Date(row.meta.ts).toISOString() },
			});
		detail.createSpan({ text: `id ${row.meta.versionId.slice(0, 12)}` });
		detail.createSpan({ text: row.meta.hash.slice(0, 16) });
		if (row.meta.effectiveParentVersionId)
			detail.createSpan({ text: `parent ${row.meta.effectiveParentVersionId.slice(0, 10)}` });
	}

	/**
	 * Overridden so a missing object does not close the picker. The base
	 * implementation chooses and closes in one step, which would drop the user
	 * back to the history window with nothing changed and nothing explained.
	 */
	selectSuggestion(row: T, event: MouseEvent | KeyboardEvent): void {
		void event;
		if (this.choosing) return;
		this.choosing = true;
		this.inputEl.disabled = true;
		void this.options
			.onChoose(row)
			.then((chosen) => {
				if (this.closed) return;
				if (chosen) {
					this.close();
					return;
				}
				new Notice("Mica: that version object is missing or unreadable. Choose another version.");
			})
			.finally(() => {
				this.choosing = false;
				if (this.closed || !this.inputEl.isConnected) return;
				this.inputEl.disabled = false;
				this.inputEl.focus();
			});
	}

	// Required by the abstract base; every path goes through `selectSuggestion`.
	onChooseSuggestion(): void {}

	onClose(): void {
		this.closed = true;
		super.onClose();
	}
}

export interface VersionLabelOptions {
	app: App;
	initial: string;
	onSave: (label: string) => Promise<boolean>;
}

/** Small validated label editor; avoids Electron's unreliable window.prompt. */
export class VersionLabelModal extends Modal {
	private input: HTMLInputElement | null = null;
	private error: HTMLElement | null = null;
	private saving = false;
	private closed = false;
	private focusFrame: number | null = null;
	private focusFrameWindow: Window | null = null;

	constructor(private readonly options: VersionLabelOptions) {
		super(options.app);
	}

	onOpen(): void {
		this.closed = false;
		this.modalEl.addClass("mica-version-label-modal");
		this.titleEl.setText(this.options.initial ? "Edit version label" : "Add version label");
		this.input = this.contentEl.createEl("input", {
			attr: { type: "text", placeholder: "Optional label", "aria-label": "Version label" },
		});
		this.input.value = this.options.initial;
		this.error = this.contentEl.createDiv({ cls: "mica-version-label-error", attr: { "aria-live": "polite" } });
		const actions = this.contentEl.createDiv({ cls: "mica-version-label-actions" });
		const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
		const save = actions.createEl("button", { cls: "mod-cta", text: "Save label", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		save.addEventListener("click", () => void this.save());
		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void this.save();
			}
		});
		this.cancelFocusFrame();
		this.focusFrameWindow = this.contentEl.win;
		this.focusFrame = this.focusFrameWindow.requestAnimationFrame(() => {
			this.focusFrame = null;
			this.focusFrameWindow = null;
			if (this.closed) return;
			this.input?.focus();
			this.input?.select();
		});
	}

	private async save(): Promise<void> {
		if (this.saving || !this.input || !this.error) return;
		const input = this.input;
		const error = this.error;
		const label = input.value.trim();
		if (/[\r\n]/.test(label)) {
			this.error.setText("Labels must fit on one line.");
			return;
		}
		this.saving = true;
		input.disabled = true;
		error.setText("Saving…");
		try {
			const saved = await this.options.onSave(label);
			if (this.closed) return;
			if (saved) this.close();
			else error.setText("The label could not be saved.");
		} finally {
			this.saving = false;
			if (!this.closed && this.input === input && input.isConnected) {
				input.disabled = false;
				input.focus();
			}
		}
	}

	private cancelFocusFrame(): void {
		if (this.focusFrame !== null) this.focusFrameWindow?.cancelAnimationFrame(this.focusFrame);
		this.focusFrame = null;
		this.focusFrameWindow = null;
	}

	onClose(): void {
		this.closed = true;
		this.cancelFocusFrame();
		this.input = null;
		this.error = null;
		this.contentEl.empty();
	}
}
