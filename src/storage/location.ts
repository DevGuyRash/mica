import { Notice, TFile, TFolder, type Vault } from "obsidian";
import type MicaPlugin from "../main";
import {
	storageLayout,
	validateStoreFolder,
	validateStoreLocation,
	validateStoreMarker,
	type StoreLocation,
} from "../wasm/bridge";
import {
	assertStoreRootCurrent,
	configureStoreRoot,
	MAX_STORE_MARKER_BYTES,
	readStoreLocation,
	resumeStoreInitialization,
	storeRoot,
	validateStoreRoot,
	writeStoreLocation,
	type StoreLocationSnapshot,
} from "./store";

interface MarkerSnapshot {
	readonly folder: string;
	readonly dir: TFolder;
	readonly file: TFile;
	readonly mtime: number;
	readonly size: number;
	readonly storeId: string;
}

function assertMarkerCurrent(vault: Vault, marker: MarkerSnapshot): void {
	const path = storageLayout(marker.folder).marker;
	if (
		vault.getAbstractFileByPath(marker.folder) !== marker.dir ||
		marker.dir.path !== marker.folder ||
		vault.getAbstractFileByPath(path) !== marker.file ||
		marker.file.path !== path ||
		marker.file.stat.mtime !== marker.mtime ||
		marker.file.stat.size !== marker.size
	)
		throw new Error("Mica: storage marker changed during relocation preflight");
}

/** Folder moves happen before any history worker or identity index is installed. */
async function markerAt(vault: Vault, folder: string): Promise<MarkerSnapshot | null> {
	const dir = vault.getAbstractFileByPath(folder);
	if (!dir) return null;
	if (!(dir instanceof TFolder)) throw new Error("Mica: storage location is not a folder");
	const path = storageLayout(folder).marker;
	const file = vault.getAbstractFileByPath(path);
	if (!file && dir.children.length === 0) return null;
	if (!(file instanceof TFile) || file.stat.size > MAX_STORE_MARKER_BYTES)
		throw new Error("Mica: storage marker is missing or invalid");
	const mtime = file.stat.mtime,
		size = file.stat.size;
	const text = await vault.read(file);
	if (new TextEncoder().encode(text).byteLength > MAX_STORE_MARKER_BYTES)
		throw new Error("Mica: invalid storage marker size");
	const marker = {
		folder,
		dir,
		file,
		mtime,
		size,
		storeId: validateStoreMarker(JSON.parse(text) as unknown).storeId,
	};
	assertMarkerCurrent(vault, marker);
	return marker;
}

function nonOverlapping(source: string, target: string): void {
	const a = source.toLowerCase(),
		b = target.toLowerCase();
	if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
		throw new Error("Mica: choose a separate storage folder");
}

function destinationAvailable(vault: Vault, target: string): void {
	if (vault.getAbstractFileByPath(target))
		throw new Error("Mica: the destination already exists; choose a new folder");
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
	if (current.file !== expected.file || current.text !== expected.text)
		throw new Error("Mica: storage location changed; restart before continuing");
}

async function finishMove(vault: Vault, snapshot: StoreLocationSnapshot): Promise<StoreLocationSnapshot> {
	const location = snapshot.location;
	if (!location?.previousFolder || !location.storeId) throw new Error("Mica: invalid pending storage move");
	const previousFolder = location.previousFolder;
	const defaultFolder = storageLayout().root;
	const assertNoCompetingDefault = (): void => {
		if (
			location.folder !== defaultFolder &&
			previousFolder !== defaultFolder &&
			vault.getAbstractFileByPath(defaultFolder)
		)
			throw new Error("Mica: the reserved default storage folder conflicts with the recorded move");
	};
	assertNoCompetingDefault();
	const source = vault.getAbstractFileByPath(previousFolder);
	const destination = vault.getAbstractFileByPath(location.folder);
	if (source && destination)
		throw new Error("Mica: both storage folders exist; resolve the interrupted move without merging them");
	if (!source && !destination)
		throw new Error("Mica: neither recorded storage folder exists; restore the missing history first");
	if (source) {
		if (!(source instanceof TFolder)) throw new Error("Mica: the recorded source storage location is not a folder");
		const sourceMarker = await markerAt(vault, previousFolder);
		if (sourceMarker === null || sourceMarker.storeId !== location.storeId || sourceMarker.dir !== source)
			throw new Error("Mica: the recorded source store identity does not match");
		destinationAvailable(vault, location.folder);
		let parent = "";
		for (const part of location.folder.split("/").slice(0, -1)) {
			parent = parent ? `${parent}/${part}` : part;
			await requireSnapshot(vault, snapshot);
			assertMarkerCurrent(vault, sourceMarker);
			assertNoCompetingDefault();
			if (!vault.getAbstractFileByPath(parent)) await vault.createFolder(parent);
			if (!(vault.getAbstractFileByPath(parent) instanceof TFolder))
				throw new Error("Mica: destination parent changed");
		}
		const movingMarker = await markerAt(vault, previousFolder);
		if (movingMarker === null || movingMarker.storeId !== location.storeId || movingMarker.dir !== source)
			throw new Error("Mica: source store identity changed");
		await requireSnapshot(vault, snapshot);
		assertMarkerCurrent(vault, movingMarker);
		assertNoCompetingDefault();
		destinationAvailable(vault, location.folder);
		await vault.rename(source, location.folder);
	}
	const movedMarker = await markerAt(vault, location.folder);
	if (movedMarker === null || movedMarker.storeId !== location.storeId)
		throw new Error("Mica: moved store identity could not be verified");
	return writeStoreLocation(vault, snapshot, { ...location, previousFolder: null }, () => {
		assertMarkerCurrent(vault, movedMarker);
		assertNoCompetingDefault();
		if (vault.getAbstractFileByPath(previousFolder))
			throw new Error("Mica: both storage folders exist; pending move was preserved");
	});
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
	await validateStoreRoot(storeRoot(vault));
	const current = snapshot.location?.folder ?? storageLayout().root;
	const pending = plugin.settings.pendingStorageFolder;
	if (pending !== null) {
		const target = validateStoreFolder(pending);
		if (target !== current) {
			nonOverlapping(current, target);
			destinationAvailable(vault, target);
			const root = storeRoot(vault);
			const storeId = await validateStoreRoot(root);
			await requireSnapshot(vault, snapshot);
			const location: StoreLocation = validateStoreLocation({
				format: storageLayout().format,
				folder: target,
				storeId,
				previousFolder: storeId ? current : null,
				initializing: false,
			});
			snapshot = await writeStoreLocation(vault, snapshot, location, () => {
				assertStoreRootCurrent(root);
				destinationAvailable(vault, target);
			});
			if (storeId) snapshot = await finishMove(vault, snapshot);
			configureStoreRoot(vault, snapshot.location);
		}
	}
	const folder = snapshot.location?.folder ?? storageLayout().root;
	await validateStoreRoot(storeRoot(vault));
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
		if (snapshot.location?.previousFolder || snapshot.location?.initializing)
			throw new Error("Mica: finish pending storage startup before choosing another folder");
		const current = storeRoot(vault).paths.root;
		if ((snapshot.location?.folder ?? storageLayout().root) !== current)
			throw new Error("Mica: storage location changed; restart first");
		if (target !== current) {
			nonOverlapping(current, target);
			destinationAvailable(vault, target);
			await validateStoreRoot(storeRoot(vault));
			await requireSnapshot(vault, snapshot);
		}
		const previous = plugin.settings.pendingStorageFolder;
		plugin.settings.pendingStorageFolder = target === current ? null : target;
		try {
			await plugin.saveSettings();
		} catch (error) {
			plugin.settings.pendingStorageFolder = previous;
			throw error;
		}
		new Notice(
			target === current
				? "Mica: the current storage folder is unchanged."
				: "Mica: folder change saved. Stop Mica CLI/watch processes, then restart Obsidian to move the history store.",
		);
	} catch (error) {
		new Notice(error instanceof Error ? error.message : "Mica: storage folder change failed");
		throw error;
	}
}
