// Obsidian host/UI boundary for the real plugin startup and storage fixture.
import type { Command } from "obsidian";

export const observations = { notices: [] as string[], events: [] as string[] };
export function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}
export class TFile {
	stat = { size: 0, mtime: 1 };
	text = "";
	vault!: unknown;
	readonly extension: string;
	constructor(public path: string) {
		this.extension = path.split(".").at(-1) ?? "";
	}
}
export class TFolder {
	children: (TFile | TFolder)[] = [];
	constructor(public path: string) {}
}
export class MarkdownView {
	refreshes = 0;
	dispatches: unknown[] = [];
	previewMode = {
		rerender: (_force: boolean): void => {
			this.refreshes += 1;
		},
	};
	editor = {
		cm: {
			dispatch: (spec: unknown): void => {
				this.dispatches.push(spec);
			},
		},
	};
}
export class Notice {
	constructor(message: string) {
		observations.notices.push(message);
	}
}
export class Plugin {
	onunload(): void {}
	unload(): void {
		this.onunload();
		for (const dispose of this.disposers.splice(0).reverse()) dispose();
	}
	commands: Command[] = [];
	disposers: (() => void)[] = [];
	saves: unknown[] = [];
	saveDataHook: () => Promise<void> = async () => undefined;
	loadDataHook: () => Promise<unknown> = async () => ({ reconcileOnLoad: false });
	constructor(public app: unknown) {}
	loadData(): Promise<unknown> {
		observations.events.push("load-data");
		return this.loadDataHook();
	}
	async saveData(value: unknown): Promise<void> {
		this.saves.push(structuredClone(value));
		await this.saveDataHook();
	}
	register(disposer: () => void): void {
		this.disposers.push(disposer);
	}
	registerEvent(_event: unknown): void {
		observations.events.push("register-event");
	}
	registerEditorExtension(_extension: unknown): void {
		observations.events.push("register-editor");
	}
	addSettingTab(_tab: unknown): void {
		observations.events.push("settings-tab");
	}
	addCommand(command: Command): void {
		this.commands.push(command);
	}
}
export class PluginSettingTab {
	constructor(..._args: unknown[]) {}
}
export class Modal {
	constructor(..._args: unknown[]) {}
}
export class Setting {}
export function getIcon(): null {
	return null;
}
export function setIcon(): void {}
export async function requestUrl(): Promise<never> {
	throw new Error("Unexpected icon network call");
}
export function debounce<T extends unknown[]>(
	callback: (...args: T) => void,
): ((...args: T) => void) & { cancel(): void } {
	return Object.assign(callback, { cancel(): void {} });
}
export function installQuickEditGlobalListeners(): () => void {
	return () => undefined;
}
export function setEditorBehavior(): void {}
export function registerViewPrefsPersistence(): void {}
export function setEditorViewPrefs(): void {}
export function setSaveShortcut(): void {}
export function bumpConfigEpoch(): void {
	observations.events.push("refresh-views");
}
export const micaRefreshEffect = { of: (value: unknown): unknown => ({ refresh: value }) };
export function micaLivePreview(): object {
	return {};
}
export function micaSourceHighlight(): object {
	return {};
}
export function registerReadingRenderer(): void {
	observations.events.push("register-reading");
}
export function setToolbarConfig(): void {}
export function disposeToolbarUi(): void {}
export function setActionMenuTrigger(): void {}
export function invalidateResponsiveActionStrips(): void {}
export const builtinTools: unknown[] = [];
export const DEFAULT_TOOLBAR_LAYOUT: string[] = [];
export class VersionsModal {
	open(): void {}
}
export class MicaApi {
	constructor() {
		observations.events.push("create-api");
	}
	registerBridge(): void {
		observations.events.push("register-bridge");
	}
	async settled(): Promise<void> {}
	dispose(): void {
		observations.events.push("dispose-api");
	}
	async runInstruction(): Promise<void> {
		observations.events.push("run-instruction");
	}
}
