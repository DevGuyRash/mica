import { setIcon } from "obsidian";
import type { MdEditor } from "./mdEditor";
import { SEARCH_WORKER_SOURCE } from "./searchWorker";

interface SearchRequest {
	id: number;
	type: "scan" | "replace";
	doc: string;
	needle: string;
	regex: boolean;
	flags: string;
	matchCase: boolean;
	replacement?: string;
	target?: number;
}

type SearchResponse =
	| { id: number; ok: true; type: "scan"; ranges: ArrayBuffer }
	| { id: number; ok: true; type: "replace"; text: string }
	| { id: number; ok: false; error: string };

/** Full-lightbox find/replace. Matching is O(document + matches) off-thread;
 * compact UTF-16 pairs provide exact counts and instant navigation. */
export class LightboxSearch {
	private readonly input: HTMLInputElement;
	private readonly replacement: HTMLInputElement;
	private readonly regex: HTMLInputElement;
	private readonly matchCase: HTMLInputElement;
	private readonly flags: HTMLInputElement;
	private readonly flagsWrap: HTMLElement;
	private readonly status: HTMLElement;
	private readonly replaceRow: HTMLElement;
	private worker: Worker;
	private workerUrl: string;
	private generation = 0;
	private resultsGeneration = -1;
	private activeRequest = -1;
	private ranges = new Uint32Array();
	private current = -1;
	private debounce: number | null = null;
	private timeout: number | null = null;
	private destroyed = false;

	constructor(
		private readonly host: HTMLElement,
		private readonly editor: MdEditor,
		private readonly onVisibilityChange?: (open: boolean) => void,
	) {
		host.addClass("mica-find-ribbon");
		host.hidden = true;
		const findRow = host.createDiv({ cls: "mica-find-row" });
		this.input = findRow.createEl("input", {
			cls: "mica-find-input",
			attr: { type: "text", placeholder: "Find", "aria-label": "Find" },
		});
		this.status = findRow.createSpan({ cls: "mica-find-status", attr: { "aria-live": "polite" } });
		this.iconButton(findRow, "chevron-up", "Previous match", () => this.move(-1));
		this.iconButton(findRow, "chevron-down", "Next match", () => this.move(1));
		const regexLabel = findRow.createEl("label", { cls: "mica-find-option" });
		this.regex = regexLabel.createEl("input", { attr: { type: "checkbox" } });
		regexLabel.createSpan({ text: "Regex" });
		this.flagsWrap = findRow.createEl("label", { cls: "mica-find-flags" });
		this.flagsWrap.createSpan({ text: "Flags" });
		this.flags = this.flagsWrap.createEl("input", {
			attr: {
				type: "text",
				value: "i",
				spellcheck: "false",
				"aria-label": "JavaScript regular expression flags",
			},
		});
		this.flagsWrap.hidden = true;
		const caseLabel = findRow.createEl("label", { cls: "mica-find-option" });
		this.matchCase = caseLabel.createEl("input", { attr: { type: "checkbox" } });
		caseLabel.createSpan({ text: "Match case" });
		this.iconButton(findRow, "replace", "Show or hide replacement", () => {
			this.replaceRow.hidden = !this.replaceRow.hidden;
			if (!this.replaceRow.hidden) this.replacement.focus();
		});
		this.iconButton(findRow, "x", "Close search", () => this.close());

		this.replaceRow = host.createDiv({ cls: "mica-find-row mica-replace-row" });
		this.replaceRow.hidden = true;
		this.replacement = this.replaceRow.createEl("input", {
			cls: "mica-find-input",
			attr: { type: "text", placeholder: "Replace", "aria-label": "Replace" },
		});
		const replaceOne = this.replaceRow.createEl("button", { text: "Replace", attr: { type: "button" } });
		replaceOne.addEventListener("click", () => this.runReplace(false));
		const replaceAll = this.replaceRow.createEl("button", { text: "Replace all", attr: { type: "button" } });
		replaceAll.addEventListener("click", () => this.runReplace(true));

		this.workerUrl = URL.createObjectURL(new Blob([SEARCH_WORKER_SOURCE], { type: "text/javascript" }));
		this.worker = this.createWorker();
		for (const control of [this.input, this.flags])
			control.addEventListener("input", () => this.invalidateAndSchedule());
		for (const control of [this.matchCase, this.regex])
			control.addEventListener("change", () => this.invalidateAndSchedule());
		this.regex.addEventListener("change", () => {
			this.flagsWrap.hidden = !this.regex.checked;
			caseLabel.hidden = this.regex.checked;
		});
		host.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			} else if (event.key === "Enter" && event.target !== this.replacement) {
				event.preventDefault();
				this.move(event.shiftKey ? -1 : 1);
			}
		});
	}

	get isOpen(): boolean {
		return !this.host.hidden;
	}

	open(showReplace = false): void {
		this.host.hidden = false;
		this.onVisibilityChange?.(true);
		if (showReplace) this.replaceRow.hidden = false;
		this.input.focus();
		this.input.select();
		this.invalidateAndSchedule(0);
	}

	close(): void {
		this.invalidate();
		this.host.hidden = true;
		this.onVisibilityChange?.(false);
		this.clearResults();
		// Do not push the editor's Obsidian keymap Scope while the Escape that
		// closed search is still being dispatched. Otherwise the same keystroke
		// can reach the editor's cancel binding and arm/confirm lightbox discard.
		queueMicrotask(() => {
			if (!this.destroyed && this.host.isConnected && this.host.hidden) this.editor.focus();
		});
	}

	onDocumentChanged(): void {
		if (this.isOpen) this.invalidateAndSchedule();
	}

	destroy(): void {
		this.destroyed = true;
		this.onVisibilityChange?.(false);
		if (this.debounce !== null) window.clearTimeout(this.debounce);
		if (this.timeout !== null) window.clearTimeout(this.timeout);
		this.worker.terminate();
		URL.revokeObjectURL(this.workerUrl);
		this.clearResults();
	}

	private createWorker(): Worker {
		const worker = new Worker(this.workerUrl);
		worker.addEventListener("message", (event: MessageEvent<SearchResponse>) => this.receive(event.data));
		return worker;
	}

	private schedule(delay = 120): void {
		if (this.debounce !== null) window.clearTimeout(this.debounce);
		this.debounce = window.setTimeout(() => {
			this.debounce = null;
			this.scan();
		}, delay);
	}

	private invalidateAndSchedule(delay = 120): void {
		this.invalidate();
		if (this.input.value) this.status.setText("Searching…");
		this.schedule(delay);
	}

	private invalidate(): void {
		this.generation++;
		this.resultsGeneration = -1;
		this.clearHighlights();
	}

	private scan(): void {
		if (!this.input.value) {
			this.clearResults();
			return;
		}
		this.post({
			id: ++this.generation,
			type: "scan",
			doc: this.editor.getValue(),
			needle: this.input.value,
			regex: this.regex.checked,
			flags: this.flags.value,
			matchCase: this.matchCase.checked,
		});
		this.status.setText("Searching…");
	}

	private runReplace(all: boolean): void {
		if (this.resultsGeneration !== this.generation || !this.ranges.length || (!all && this.current < 0)) return;
		const target = all ? -1 : this.current;
		const request: SearchRequest = {
			id: ++this.generation,
			type: "replace",
			doc: this.editor.getValue(),
			needle: this.input.value,
			regex: this.regex.checked,
			flags: this.flags.value,
			matchCase: this.matchCase.checked,
			replacement: this.replacement.value,
			target,
		};
		this.resultsGeneration = -1;
		this.clearHighlights();
		this.post(request);
		this.status.setText("Replacing…");
	}

	private post(request: SearchRequest): void {
		if (this.timeout !== null) window.clearTimeout(this.timeout);
		this.activeRequest = request.id;
		this.worker.postMessage(request);
		this.timeout = window.setTimeout(() => {
			if (request.id !== this.activeRequest || this.destroyed) return;
			this.worker.terminate();
			this.worker = this.createWorker();
			this.activeRequest = -1;
			this.timeout = null;
			if (request.id === this.generation) this.status.setText("Pattern took too long");
			this.clearHighlights();
		}, 500);
	}

	private receive(response: SearchResponse): void {
		if (response.id === this.activeRequest) {
			if (this.timeout !== null) window.clearTimeout(this.timeout);
			this.timeout = null;
			this.activeRequest = -1;
		}
		if (response.id !== this.generation || this.destroyed) return;
		if (!response.ok) {
			this.status.setText(response.error);
			this.clearHighlights();
			return;
		}
		if (response.type === "replace") {
			this.editor.setValue(response.text);
			// A real document transaction invalidates synchronously through
			// onDocumentChanged. If the replacement was byte-identical, explicitly
			// request the fresh result set here.
			if (this.generation === response.id) this.invalidateAndSchedule(0);
			return;
		}
		this.ranges = new Uint32Array(response.ranges);
		this.resultsGeneration = response.id;
		const count = this.ranges.length / 2;
		if (!count) {
			this.current = -1;
			this.status.setText("0 matches");
			this.editor.setSearchHighlights(this.ranges, -1);
			return;
		}
		const caret = this.editor.view.state.selection.main.head;
		this.current = this.firstAtOrAfter(caret);
		this.paintCurrent(false);
	}

	private move(delta: number): void {
		const count = this.ranges.length / 2;
		if (!count) return;
		const raw = this.current + delta;
		this.current = (raw + count) % count;
		this.paintCurrent(true, raw < 0 || raw >= count);
	}

	private paintCurrent(reveal: boolean, wrapped = false): void {
		const count = this.ranges.length / 2;
		this.status.setText(`${this.current + 1} of ${count}${wrapped ? " · wrapped" : ""}`);
		this.editor.setSearchHighlights(this.ranges, this.current);
		if (reveal) this.editor.revealRange(this.ranges[this.current * 2], this.ranges[this.current * 2 + 1]);
	}

	private firstAtOrAfter(position: number): number {
		let low = 0;
		let high = this.ranges.length / 2;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.ranges[middle * 2] < position) low = middle + 1;
			else high = middle;
		}
		return low < this.ranges.length / 2 ? low : 0;
	}

	private clearResults(): void {
		this.status.setText("");
		this.resultsGeneration = -1;
		this.clearHighlights();
	}

	private clearHighlights(): void {
		this.ranges = new Uint32Array();
		this.current = -1;
		this.editor.setSearchHighlights(this.ranges, -1);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, run: () => void): void {
		const button = parent.createEl("button", {
			cls: "clickable-icon mica-find-icon",
			attr: { type: "button", "aria-label": label },
		});
		setIcon(button, icon);
		button.addEventListener("click", run);
	}
}
