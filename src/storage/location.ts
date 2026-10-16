import { Notice, TFile, TFolder, type Vault } from "obsidian";
import type MicaPlugin from "../main";
import { storageLayout, validateStoreFolder, validateStoreLocation, validateStoreMarker, type StoreLocation } from "../wasm/bridge";
import { configureStoreRoot, readStoreLocation, resumeStoreInitialization, storeRoot, validateStoreRoot, writeStoreLocation, type StoreLocationSnapshot } from "./store";

/** Folder moves happen before any history worker or identity index is installed. */
async function markerAt(vault: Vault, folder: string): Promise<string | null> {
	const dir = vault.getAbstractFileByPath(folder);
	if (!dir) return null;
	if (!(dir instanceof TFolder)) throw new Error("Mica: storage location is not a folder");
	const path = storageLayout(folder).marker;
	const file = vault.getAbstractFileByPath(path);
	if (!file && dir.children.length === 0) return null;
	if (!(file instanceof TFile) || file.stat.size > 4096) throw new Error("Mica: storage marker is missing or invalid");
	const mtime = file.stat.mtime, size = file.stat.size;
	const text = await vault.read(file);
	if (vault.getAbstractFileByPath(folder) !== dir || vault.getAbstractFileByPath(path) !== file ||
		file.stat.mtime !== mtime || file.stat.size !== size || new TextEncoder().encode(text).byteLength > 4096)
		throw new Error("Mica: storage marker changed during relocation preflight");
	return validateStoreMarker(JSON.parse(text) as unknown).storeId;
}

function nonOverlapping(source: string, target: string): void {
	const a = source.toLowerCase(), b = target.toLowerCase();
	if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) throw new Error("Mica: choose a separate storage folder");
}

function destinationAvailable(vault: Vault, target: string): void {
	if (vault.getAbstractFileByPath(target)) throw new Error("Mica: the destination already exists; choose a new folder");
	const parts = target.split("/");
	let path = "";
	for (const part of parts.slice(0, -1)) {
		path = path ? `${path}/${part}` : part;
		const entry = vault.getAbstractFileByPath(path);
		if (entry && !(entry instanceof TFolder)) throw new Error("Mica: a destination parent is not a folder");
	}
}

async function requireSnapshot(vault: Vault, expected: StoreLocationSnapshot): Promise<void> {
	const current = await readStoreLocation(vault);
	if (current.file !== expected.file || current.text !== expected.text) throw new Error("Mica: storage location changed; restart before continuing");
}

async function finishMove(vault: Vault, snapshot: StoreLocationSnapshot): Promise<StoreLocationSnapshot> {
	const location = snapshot.location;
	if (!location?.previousFolder || !location.storeId) throw new Error("Mica: invalid pending storage move");
	const source = vault.getAbstractFileByPath(location.previousFolder);
	const destination = vault.getAbstractFileByPath(location.folder);
	if (source && destination) throw new Error("Mica: both storage folders exist; resolve the interrupted move without merging them");
	if (!source && !destination) throw new Error("Mica: neither recorded storage folder exists; restore the missing history first");
	if (source) {
		if (!(source instanceof TFolder) || await markerAt(vault, location.previousFolder) !== location.storeId)
			throw new Error("Mica: the recorded source store identity does not match");
		destinationAvailable(vault, location.folder);
		let parent = "";
		for (const part of location.folder.split("/").slice(0, -1)) {
			parent = parent ? `${parent}/${part}` : part;
			await requireSnapshot(vault, snapshot);
			if (!vault.getAbstractFileByPath(parent)) await vault.createFolder(parent);
			if (!(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new Error("Mica: destination parent changed");
		}
		if (await markerAt(vault, location.previousFolder) !== location.storeId) throw new Error("Mica: source store identity changed");
		await requireSnapshot(vault, snapshot);
		destinationAvailable(vault, location.folder);
		if (vault.getAbstractFileByPath(location.previousFolder) !== source) throw new Error("Mica: source folder changed");
		await vault.rename(source, location.folder);
	}
	if (await markerAt(vault, location.folder) !== location.storeId) throw new Error("Mica: moved store identity could not be verified");
	return writeStoreLocation(vault, snapshot, { ...location, previousFolder: null });
}

/** The locator wins over a stale settings mirror, including on another device. */
export async function initializeStorageLocation(plugin: MicaPlugin): Promise<void> {
	const vault = plugin.app.vault;
	let snapshot = await readStoreLocation(vault);
	if (snapshot.location?.previousFolder) snapshot = await finishMove(vault, snapshot);
	configureStoreRoot(vault, snapshot.location);
	if (snapshot.location?.initializing) {
		await resumeStoreInitialization(storeRoot(vault));
		snapshot = await readStoreLocation(vault);
	}
	const current = snapshot.location?.folder ?? storageLayout().root;
	const pending = plugin.settings.pendingStorageFolder;
	if (pending !== null) {
		const target = validateStoreFolder(pending);
		if (target !== current) {
			nonOverlapping(current, target);
			destinationAvailable(vault, target);
			const storeId = await validateStoreRoot(storeRoot(vault));
			await requireSnapshot(vault, snapshot);
			const location: StoreLocation = validateStoreLocation({ format: storageLayout().format, folder: target, storeId, previousFolder: storeId ? current : null, initializing: false });
			snapshot = await writeStoreLocation(vault, snapshot, location);
			if (storeId) snapshot = await finishMove(vault, snapshot);
			configureStoreRoot(vault, snapshot.location);
		}
	}
	const folder = snapshot.location?.folder ?? storageLayout().root;
	if (plugin.settings.storageFolder !== folder || pending !== null) {
		plugin.settings.storageFolder = folder;
		plugin.settings.pendingStorageFolder = null;
		await plugin.saveSettings();
	}
}

/** Typing is a draft. Only explicit Apply records a request; workers keep the active route. */
export async function requestStorageFolder(plugin: MicaPlugin, draft: string): Promise<void> {
	try {
		const vault = plugin.app.vault;
		const target = validateStoreFolder(draft.trim() || storageLayout().root);
		const snapshot = await readStoreLocation(vault);
		if (snapshot.location?.previousFolder || snapshot.location?.initializing) throw new Error("Mica: finish pending storage startup before choosing another folder");
		const current = storeRoot(vault).paths.root;
		if ((snapshot.location?.folder ?? storageLayout().root) !== current) throw new Error("Mica: storage location changed; restart first");
		if (target !== current) {
			nonOverlapping(current, target);
			destinationAvailable(vault, target);
			await validateStoreRoot(storeRoot(vault));
			await requireSnapshot(vault, snapshot);
		}
		const previous = plugin.settings.pendingStorageFolder;
		plugin.settings.pendingStorageFolder = target === current ? null : target;
		try { await plugin.saveSettings(); }
		catch (error) { plugin.settings.pendingStorageFolder = previous; throw error; }
		new Notice(target === current ? "Mica: the current storage folder is unchanged." : "Mica: folder change saved. Stop Mica CLI/watch processes, then restart Obsidian to move the history store.");
	} catch (error) {
		new Notice(error instanceof Error ? error.message : "Mica: storage folder change failed");
		throw error;
	}
}
