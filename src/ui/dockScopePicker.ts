import { FuzzySuggestModal, setIcon, type App, type FuzzyMatch } from "obsidian";
import type { DockTargetController } from "./dockScope";
import type { VersionScope } from "./versionScopeCore";

type PickerChoice =
	| { kind: "resume"; label: string }
	| { kind: "copy-block"; label: string }
	| { kind: "scope"; label: string; scope: VersionScope };

/** Searchable structural scope chooser. Selecting a scope pins it; the first
 * action restores contextual targeting without requiring a separate modal. */
export class DockScopePicker extends FuzzySuggestModal<PickerChoice> {
	constructor(
		app: App,
		private readonly controller: DockTargetController,
		private readonly copyBlock: () => void,
	) {
		super(app);
		const current = controller.current();
		this.setPlaceholder(`Copy scope · ${reasonLabel(current.reason)} · ${current.label}`);
	}

	getItems(): PickerChoice[] {
		const current = this.controller.current();
		const scopes: PickerChoice[] = this.controller.scopes().map((scope) => ({
			kind: "scope" as const,
			label: this.controller.describe(scope).breadcrumb.join(" › "),
			scope,
		}));
		const choices: PickerChoice[] = [
			{
				kind: "resume",
				label:
					current.reason === "manual" ? "Return to whole-block manual target" : "Resume automatic targeting",
			},
			{ kind: "copy-block", label: "Copy whole block now" },
			...scopes.sort((left, right) => {
				if (left.kind !== "scope" || right.kind !== "scope") return 0;
				return left.scope.start - right.scope.start || left.scope.end - right.scope.end;
			}),
		];
		return choices.map((choice): PickerChoice =>
			choice.kind === "scope" && choice.scope.key === current.scope.key
				? { ...choice, label: `${choice.label} · Current` }
				: choice,
		);
	}

	getItemText(item: PickerChoice): string {
		return item.label;
	}

	renderSuggestion(match: FuzzyMatch<PickerChoice>, el: HTMLElement): void {
		const item = match.item;
		el.addClass("mica-dock-scope-suggestion");
		const icon = el.createSpan({ cls: "mica-dock-scope-suggestion-icon" });
		setIcon(
			icon,
			item.kind === "resume" ? "scan" : item.kind === "copy-block" ? "copy" : scopeIcon(item.scope.kind),
		);
		const copy = el.createDiv({ cls: "mica-dock-scope-suggestion-copy" });
		copy.createDiv({ cls: "mica-dock-scope-suggestion-label", text: item.label });
		if (item.kind === "scope")
			copy.createDiv({
				cls: "mica-dock-scope-suggestion-kind",
				text: `${kindLabel(item.scope.kind)} · selecting pins this scope`,
			});
	}

	onChooseItem(item: PickerChoice): void {
		if (item.kind === "resume") this.controller.resumeAutomatic();
		else if (item.kind === "copy-block") this.copyBlock();
		else this.controller.pin(item.scope.key);
	}
}

function reasonLabel(reason: ReturnType<DockTargetController["current"]>["reason"]): string {
	return reason === "automatic"
		? "Automatic"
		: reason === "focused"
			? "Focused"
			: reason === "pinned"
				? "Pinned"
				: reason === "manual"
					? "Manual"
					: "Whole block";
}

function scopeIcon(kind: VersionScope["kind"]): string {
	switch (kind) {
		case "tabs":
			return "panels-top-left";
		case "tab":
			return "panel-top";
		case "grid":
			return "layout-grid";
		case "cell":
			return "square";
		case "callout":
			return "message-square";
		case "code":
			return "code-2";
		case "section":
			return "align-left";
		case "block":
			return "box";
	}
}

function kindLabel(kind: VersionScope["kind"]): string {
	return kind === "code" ? "Code block" : `${kind[0].toUpperCase()}${kind.slice(1)}`;
}
