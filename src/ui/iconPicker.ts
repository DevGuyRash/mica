import { getIcon, getIconIds, Modal, setIcon, type App } from "obsidian";
import { exactPackIconCandidate, findIconPack, packIconId, splitPackIconId, type IconPack } from "../icons/iconPacks";
import { iconPackCatalog, loadPackIcon } from "../icons/iconPackRuntime";
import { setMicaIcon } from "../icons/setMicaIcon";

export interface IconPickerOptions {
	app: App;
	/** Opt-in packs to offer alongside Obsidian's built-in icons. */
	enabledPacks?: readonly string[];
	title?: string;
	/** Icon currently assigned to the object, if any. */
	current?: string | null;
	/** Called only after choosing a valid icon or explicitly clearing it. */
	onChoose: (icon: string | null) => void;
}

const ICON_BATCH_SIZE = 36;

/** Stable, case-insensitive matching used by the picker and focused tests. */
export function filterIconIds(iconIds: readonly string[], query: string): string[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return [...iconIds];
	return iconIds.filter((id) => id.toLocaleLowerCase().includes(needle));
}

/**
 * Searchable picker for Obsidian's runtime icon catalog. The catalog is read
 * when the modal opens so the picker follows the installed Obsidian version.
 */
export class IconPickerModal extends Modal {
	private readonly current: string | null;
	private iconIds: string[] = [];
	private searchIndex: Array<readonly [id: string, normalized: string]> = [];
	private filteredIds: string[] = [];
	private renderedIds: string[] = [];
	private renderedButtons: HTMLButtonElement[] = [];
	private visibleCount = ICON_BATCH_SIZE;
	private query = "";
	private searchEl: HTMLInputElement | null = null;
	private gridEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private renderFrame: number | null = null;
	private enabledPackIds = new Set<string>();
	private lifecycleGeneration = 0;
	private commitGeneration = 0;

	constructor(private readonly options: IconPickerOptions) {
		super(options.app);
		this.current = options.current?.trim() || null;
	}

	onOpen(): void {
		const generation = ++this.lifecycleGeneration;
		this.commitGeneration++;
		this.enabledPackIds = new Set(this.options.enabledPacks ?? []);
		this.modalEl.addClass("mica-icon-picker-modal");
		this.titleEl.setText(this.options.title ?? "Choose an icon");

		// getIcon() materializes SVG data. Validating the entire ~2k catalog here
		// made opening the picker needlessly expensive; validate only at commit.
		this.iconIds = [...new Set(getIconIds().map(String))].sort((a, b) => a.localeCompare(b));
		this.searchIndex = this.iconIds.map((id) => [id, id.toLocaleLowerCase()] as const);
		// Enabled packs load in the background; the built-in catalog is usable
		// immediately rather than waiting on a network round trip.
		void this.appendEnabledPacks(generation);

		const root = this.contentEl.createDiv({ cls: "mica-icon-picker" });
		const searchRow = root.createDiv({ cls: "mica-icon-picker-search" });
		const searchIcon = searchRow.createSpan({ cls: "mica-icon-picker-search-icon" });
		setIcon(searchIcon, "search");
		this.searchEl = searchRow.createEl("input", {
			type: "search",
			placeholder: "Search icons",
			attr: {
				"aria-label": "Search icons",
				autocomplete: "off",
				spellcheck: "false",
			},
		});
		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl?.value ?? "";
			this.visibleCount = ICON_BATCH_SIZE;
			this.scheduleRender();
		});
		this.searchEl.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowDown") return;
			event.preventDefault();
			this.focusIcon(this.initialFocusIndex());
		});

		this.statusEl = root.createDiv({
			cls: "mica-icon-picker-status",
			attr: { "aria-live": "polite", "aria-atomic": "true" },
		});
		this.gridEl = root.createDiv({
			cls: "mica-icon-picker-grid",
			attr: { role: "listbox", "aria-label": "Available icons" },
		});

		const footer = root.createDiv({ cls: "mica-icon-picker-footer" });
		const clear = footer.createEl("button", {
			text: "Remove icon",
			cls: "mica-icon-picker-clear",
			attr: { type: "button" },
		});
		clear.addEventListener("click", () => this.commit(null));
		const cancel = footer.createEl("button", {
			text: "Cancel",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => this.close());

		this.renderIcons();
		this.searchEl.focus();
	}

	onClose(): void {
		this.lifecycleGeneration++;
		this.commitGeneration++;
		if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
		this.renderFrame = null;
		this.contentEl.empty();
		this.searchEl = null;
		this.gridEl = null;
		this.statusEl = null;
		this.renderedButtons = [];
	}

	/**
	 * Fold every enabled pack's catalog into the searchable list.
	 *
	 * Packs with no whole-set payload publish no catalog, so they contribute
	 * nothing here and are reached by typing their `pack:name` id directly.
	 */
	private async appendEnabledPacks(generation: number): Promise<void> {
		const added: string[] = [];
		for (const packId of this.enabledPackIds) {
			if (generation !== this.lifecycleGeneration) return;
			const pack = findIconPack(packId);
			if (!pack) continue;
			const catalog = await iconPackCatalog(pack);
			if (generation !== this.lifecycleGeneration) return;
			for (const icon of catalog) added.push(packIconId(pack.id, icon));
		}
		// The modal may have closed while a pack was downloading.
		if (generation !== this.lifecycleGeneration || !added.length || !this.gridEl) return;
		this.iconIds = [...new Set([...this.iconIds, ...added])].sort((left, right) => left.localeCompare(right));
		this.searchIndex = this.iconIds.map((id) => [id, id.toLocaleLowerCase()] as const);
		this.renderIcons();
	}

	/** Coalesce fast typing into one bounded SVG render per animation frame. */
	private scheduleRender(): void {
		if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
		this.renderFrame = requestAnimationFrame(() => {
			this.renderFrame = null;
			this.renderIcons();
		});
	}

	private renderIcons(): void {
		if (!this.gridEl || !this.statusEl) return;
		const needle = this.query.trim().toLocaleLowerCase();
		if (needle) {
			const matches: string[] = [];
			const exactPackCandidate = exactPackIconCandidate(this.query, this.enabledPackIds);
			let foundExactPackCandidate = false;
			for (const [id, normalized] of this.searchIndex) {
				if (!normalized.includes(needle)) continue;
				matches.push(id);
				if (id === exactPackCandidate) foundExactPackCandidate = true;
			}
			if (exactPackCandidate && !foundExactPackCandidate) matches.push(exactPackCandidate);
			this.filteredIds = matches;
		} else {
			// Background pack loading replaces, rather than mutates, this array.
			this.filteredIds = this.iconIds;
		}
		this.renderedIds = this.filteredIds.slice(0, this.visibleCount);
		if (this.current && this.filteredIds.includes(this.current) && !this.renderedIds.includes(this.current)) {
			this.renderedIds = [this.current, ...this.renderedIds.slice(0, -1)];
		}
		this.gridEl.empty();
		this.renderedButtons = [];
		const total = this.filteredIds.length;
		this.statusEl.setText(
			total <= this.renderedIds.length
				? total === 1
					? "1 icon"
					: `${total.toLocaleString()} icons`
				: `Showing ${this.renderedIds.length.toLocaleString()} of ${total.toLocaleString()} icons`,
		);

		if (this.filteredIds.length === 0) {
			this.gridEl.createDiv({
				cls: "mica-icon-picker-empty",
				text: "No icons match this search.",
				attr: { role: "status" },
			});
			return;
		}

		const initialFocusIndex = this.initialFocusIndex();
		for (const [index, id] of this.renderedIds.entries()) {
			const selected = id === this.current;
			const button = this.gridEl.createEl("button", {
				cls: `mica-icon-picker-option${selected ? " is-selected" : ""}`,
				attr: {
					type: "button",
					role: "option",
					"aria-label": id,
					"aria-selected": String(selected),
					title: id,
					tabindex: index === initialFocusIndex ? "0" : "-1",
					"data-icon-id": id,
				},
			});
			setMicaIcon(button.createSpan({ cls: "mica-icon-picker-glyph" }), id, this.enabledPackIds);
			button.createSpan({ cls: "mica-icon-picker-name", text: id });
			button.addEventListener("click", () => this.commit(id));
			button.addEventListener("keydown", (event) => this.onIconKeydown(event, index));
			this.renderedButtons.push(button);
		}
		if (this.renderedIds.length < total) {
			const more = this.gridEl.createEl("button", {
				cls: "mica-icon-picker-more",
				text: `Show ${Math.min(ICON_BATCH_SIZE, total - this.renderedIds.length)} more`,
				attr: { type: "button" },
			});
			more.addEventListener("click", () => {
				const next = this.renderedIds.length;
				this.visibleCount += ICON_BATCH_SIZE;
				this.renderIcons();
				this.focusIcon(next);
			});
		}
	}

	private initialFocusIndex(): number {
		const selected = this.current ? this.renderedIds.indexOf(this.current) : -1;
		return selected >= 0 ? selected : 0;
	}

	private onIconKeydown(event: KeyboardEvent, index: number): void {
		let target = index;
		switch (event.key) {
			case "ArrowRight":
				target = Math.min(index + 1, this.renderedIds.length - 1);
				break;
			case "ArrowLeft":
				target = Math.max(index - 1, 0);
				break;
			case "ArrowDown":
				target = Math.min(index + this.columnCount(), this.renderedIds.length - 1);
				break;
			case "ArrowUp":
				target = Math.max(index - this.columnCount(), 0);
				break;
			case "Home":
				target = 0;
				break;
			case "End":
				target = this.renderedIds.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		this.focusIcon(target);
	}

	private columnCount(): number {
		if (this.renderedButtons.length < 2) return 1;
		const firstTop = this.renderedButtons[0]?.offsetTop;
		const nextRow = this.renderedButtons.findIndex((button) => button.offsetTop !== firstTop);
		return nextRow > 0 ? nextRow : this.renderedButtons.length;
	}

	private focusIcon(index: number): void {
		if (index < 0) return;
		const target = this.renderedButtons[index];
		if (!target) return;
		for (const button of this.renderedButtons) button.tabIndex = button === target ? 0 : -1;
		target.focus();
		target.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	private commit(icon: string | null): void {
		const generation = ++this.commitGeneration;
		if (icon === null) {
			this.finishCommit(null);
			return;
		}

		const parts = splitPackIconId(icon);
		if (parts) {
			const pack = findIconPack(parts.packId);
			if (!pack || !this.enabledPackIds.has(pack.id)) {
				this.reportUnavailable(icon);
				return;
			}
			void this.commitPack(icon, pack, parts.icon, generation);
			return;
		}

		// Validate at the commit boundary; themes/plugins can replace Obsidian's
		// icon registry while this modal is open.
		if (!getIcon(icon)) {
			this.reportUnavailable(icon);
			return;
		}
		this.finishCommit(icon);
	}

	private async commitPack(icon: string, pack: IconPack, name: string, generation: number): Promise<void> {
		let available = false;
		try {
			available = Boolean(await loadPackIcon(pack, name));
		} catch {
			// The loader owns network fallbacks; any unexpected failure still
			// leaves selection closed rather than publishing an unvalidated id.
		}
		if (generation !== this.commitGeneration || !this.gridEl) return;
		if (!available) {
			this.reportUnavailable(icon);
			return;
		}
		this.finishCommit(icon);
	}

	private reportUnavailable(icon: string): void {
		this.query = icon;
		if (this.searchEl) this.searchEl.value = icon;
		this.renderIcons();
		this.statusEl?.setText(`“${icon}” is no longer available.`);
	}

	private finishCommit(icon: string | null): void {
		this.options.onChoose(icon);
		this.close();
	}
}

/** Open a picker without coupling callers to its Modal implementation. */
export function openIconPicker(options: IconPickerOptions): IconPickerModal {
	const picker = new IconPickerModal(options);
	picker.open();
	return picker;
}
