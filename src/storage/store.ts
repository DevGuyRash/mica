import { TFile, TFolder, type Vault } from "obsidian";
import {
	isManagedPath, newId, noteId, notePaths, resolveObjectHash, setNoteId, storageLayout, validateStoreMarker,
	type NotePaths, type StorageLayout,
} from "../wasm/bridge";

export interface StoreRoot {
	readonly vault: Vault;
	readonly paths: StorageLayout;
}

export interface NoteStore {
	readonly root: StoreRoot;
	readonly file: TFile;
	readonly noteId: string;
	readonly paths: NotePaths;
	readonly aliases: Readonly<Record<string, string>>;
	readonly storeId: string | null;
	/** A fresh repair destination may be staged before its guarded note publication. */
	readonly expectedSource?: string;
}

interface IdentityEntry { id: string | null; error?: unknown }
interface StoreState {
	readonly root: StoreRoot;
	readonly identities: Map<TFile, IdentityEntry>;
	readonly byId: Map<string, Set<TFile>>;
	readonly errors: Set<TFile>;
	readonly pending: Map<TFile, Promise<void>>;
	readonly dirty: Set<TFile>;
	readonly revisions: Map<TFile, number>;
	indexed: Promise<void> | null;
	initializing: Promise<void> | null;
	disposed: boolean;
	epoch: number;
	legacyPresent: boolean | null;
	owner: symbol | null;
}

const roots = new WeakMap<Vault, StoreState>();

export function storeRoot(vault: Vault): StoreRoot {
	let state = roots.get(vault);
	if (!state) {
		state = { root: { vault, paths: storageLayout() }, identities: new Map(), byId: new Map(), errors: new Set(), pending: new Map(), dirty: new Set(),
			revisions: new Map(), indexed: null, initializing: null, disposed: false, epoch: 0, legacyPresent: null, owner: null };
		roots.set(vault, state);
	}
	return state.root;
}

function stateOf(root: StoreRoot): StoreState {
	storeRoot(root.vault);
	return roots.get(root.vault)!;
}

export function isLiveNote(file: TFile): boolean {
	return file.extension.toLowerCase() === "md" && !file.path.includes(".mica/") && !isManagedPath(file.path);
}

function requireLiveNote(file: TFile): void {
	if (!isLiveNote(file)) throw new Error(`Mica: managed storage is not a live note: ${file.path}`);
}

function setIdentity(state: StoreState, file: TFile, entry?: IdentityEntry): void {
	const old = state.identities.get(file);
	if (old?.id) { const group = state.byId.get(old.id); group?.delete(file); if (!group?.size) state.byId.delete(old.id); }
	state.errors.delete(file);
	state.identities.delete(file);
	if (!entry) return;
	state.identities.set(file, entry);
	if ("error" in entry) state.errors.add(file);
	if (entry.id) { const group = state.byId.get(entry.id) ?? new Set<TFile>(); group.add(file); state.byId.set(entry.id, group); }
}

function refreshIdentity(state: StoreState, file: TFile): Promise<void> {
	const epoch = state.epoch;
	const revision = (state.revisions.get(file) ?? 0) + 1;
	state.revisions.set(file, revision);
	const task = (async () => {
		try {
			const source = await state.root.vault.read(file);
			const id = noteId(source);
			if (!state.disposed && state.epoch === epoch && state.revisions.get(file) === revision) setIdentity(state, file, { id });
		} catch (error) {
			if (!state.disposed && state.epoch === epoch && state.revisions.get(file) === revision) setIdentity(state, file, { id: null, error });
		}
	})().finally(() => { if (state.pending.get(file) === task) state.pending.delete(file); });
	state.pending.set(file, task);
	return task;
}

function identityIndex(state: StoreState): Promise<void> {
	const epoch = state.epoch;
	state.indexed ??= (async () => {
		// One source-backed initial pass, not a metadata-cache guess or a per-snapshot scan.
		for (const file of state.root.vault.getMarkdownFiles()) {
			if (state.disposed || state.epoch !== epoch) return;
			if (isLiveNote(file)) await refreshIdentity(state, file);
		}
	})();
	return state.indexed;
}

async function assertUnique(root: StoreRoot, file: TFile, id: string): Promise<void> {
	const state = stateOf(root);
	for (const file of state.errors) if (root.vault.getAbstractFileByPath(file.path) === file && isLiveNote(file)) state.dirty.add(file);
	if (state.disposed) throw new Error("Mica: storage identity owner is disposed");
	await identityIndex(state);
	for (let attempt = 0; attempt < 3; attempt++) {
		for (const changed of [...state.dirty]) { if (!state.dirty.delete(changed)) continue; if (isLiveNote(changed) && root.vault.getAbstractFileByPath(changed.path) === changed) await refreshIdentity(state, changed); }
		await Promise.all(state.pending.values());
		if (!state.dirty.size && !state.pending.size) break;
	}
	if (state.pending.size) throw new Error("Mica: note identities are changing; retry after the vault settles");
	assertIndexedUnique(state, file, id);
}

function assertIndexedUnique(state: StoreState, file: TFile, id: string): void {
	if (state.pending.size || state.dirty.size) throw new Error("Mica: note identities changed during storage I/O; retry");
	for (const stale of [...state.errors]) if (state.root.vault.getAbstractFileByPath(stale.path) !== stale || !isLiveNote(stale)) setIdentity(state, stale);
	const unresolved = state.errors.values().next().value;
	if (unresolved) throw new Error(`Mica: note identity could not be verified: ${unresolved.path}`, { cause: state.identities.get(unresolved)?.error });
	for (const candidate of state.byId.get(id) ?? []) {
		if (candidate !== file && state.root.vault.getAbstractFileByPath(candidate.path) === candidate && isLiveNote(candidate))
			throw new Error(`Mica: duplicate note identity in ${file.path} and ${candidate.path}; run Repair history`);
	}
}

/** Install once after core initialization; every asynchronous read has this lifecycle owner. */
export function installStoreLifecycle(vault: Vault, settled?: () => Promise<void>): () => void {
	const state = stateOf(storeRoot(vault));
	state.disposed = false;
	const owner = Symbol("Mica storage lifecycle");
	state.owner = owner;
	const markFile = (file: TFile): void => {
		if (!isLiveNote(file)) { setIdentity(state, file); state.dirty.delete(file); return; }
		state.revisions.set(file, (state.revisions.get(file) ?? 0) + 1);
		state.dirty.add(file);
	};
	const update = (file: unknown): void => {
		if (file instanceof TFile) markFile(file);
		else if (file instanceof TFolder) {
			state.legacyPresent = null;
			const folders = [file];
			while (folders.length) for (const child of folders.pop()!.children) {
				if (child instanceof TFolder) folders.push(child);
				else if (child instanceof TFile) markFile(child);
			}
		}
	};
	const remove = (file: unknown): void => {
		if (file instanceof TFolder) state.legacyPresent = null;
		if (!(file instanceof TFile)) return;
		state.revisions.delete(file);
		setIdentity(state, file); state.dirty.delete(file);
	};
	const refs = [vault.on("create", update), vault.on("modify", update), vault.on("rename", update), vault.on("delete", remove)];
	void identityIndex(state).catch((error: unknown) => console.error("Mica: note identity index failed", error));
	let closing = false;
	return () => {
		if (closing) return;
		closing = true;
		const finish = (): void => {
			for (const ref of refs) vault.offref(ref);
			// A reload may already have installed the next owner while old queues drain.
			if (state.owner !== owner) return;
			state.owner = null;
			state.disposed = true;
			state.epoch += 1;
			state.identities.clear(); state.byId.clear(); state.errors.clear(); state.revisions.clear();
			state.pending.clear(); state.dirty.clear(); state.indexed = null;
		};
		// Admitted engine writes retain their identity supervisor until their queues settle.
		const drain = (async () => {
			try { await settled?.(); }
			finally { await Promise.allSettled([state.indexed, state.initializing, ...state.pending.values()]); }
		})();
		void drain.then(finish, (error: unknown) => { console.error("Mica: storage lifecycle drain failed", error); finish(); });
	};
}

export async function ensureStoreFolder(root: StoreRoot, path: string): Promise<void> {
	if (!isManagedPath(path) || path.includes("\\") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) throw new Error("Mica: storage folder escapes the managed root");
	let parent = "";
	for (const part of path.split("/")) {
		parent = parent ? `${parent}/${part}` : part;
		const current = root.vault.getAbstractFileByPath(parent);
		if (current instanceof TFolder) continue;
		if (current) throw new Error(`Mica: storage path is not a folder: ${parent}`);
		try { await root.vault.createFolder(parent); }
		catch (error) { if (!(root.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error; }
	}
}

/** Read lookups never create a store, and old sidecars are never silently bypassed. */
export async function validateStoreRoot(root: StoreRoot, write = false): Promise<string | null> {
	const state = stateOf(root);
	if (state.initializing) await state.initializing;
	const folder = root.vault.getAbstractFileByPath(root.paths.root);
	const marker = root.vault.getAbstractFileByPath(root.paths.marker);
	if (folder && !(folder instanceof TFolder)) throw new Error("Mica: central store root is not a folder");
	if (marker) {
		if (!(marker instanceof TFile) || marker.stat.size > 4096) throw new Error("Mica: invalid central store marker");
		const text = await root.vault.read(marker);
		if (new TextEncoder().encode(text).byteLength > 4096) throw new Error("Mica: invalid central store marker");
		return validateStoreMarker(JSON.parse(text) as unknown).storeId;
	}
	if (folder) throw new Error("Mica: central store marker is missing; an explicit offline cutover is required");
	state.legacyPresent ??= root.vault.getAllLoadedFiles().some((file) => file instanceof TFolder && file.path.endsWith(".mica"));
	if (state.legacyPresent)
		throw new Error("Mica: legacy sidecars require an explicit offline cutover before central storage can be used");
	if (!write) return null;
	const initialize = (async () => {
		await ensureStoreFolder(root, root.paths.root);
		const body = JSON.stringify({ format: root.paths.format, storeId: newId() }, null, "\t") + "\n";
		try { await root.vault.create(root.paths.marker, body); }
		catch (error) { if (!(root.vault.getAbstractFileByPath(root.paths.marker) instanceof TFile)) throw error; }
	})();
	state.initializing = initialize;
	try { await initialize; } finally { if (state.initializing === initialize) state.initializing = null; }
	return validateStoreRoot(root);
}

export const MAX_ALIAS_BYTES = 1024 * 1024;
export const MAX_ALIASES = 16384;

export async function readAliases(root: StoreRoot, path: string): Promise<Record<string, string>> {
	const file = root.vault.getAbstractFileByPath(path);
	if (!file) return {};
	if (!(file instanceof TFile) || file.stat.size > MAX_ALIAS_BYTES) throw new Error(`Mica: invalid alias document: ${path}`);
	return parseAliases(await root.vault.read(file));
}

export function parseAliases(text: string): Record<string, string> {
	if (new TextEncoder().encode(text).byteLength > MAX_ALIAS_BYTES) throw new Error("Mica: alias document is too large");
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Mica: invalid alias document");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_ALIASES) throw new Error("Mica: too many object aliases");
	const aliases: Record<string, string> = {};
	for (const [key, full] of entries) {
		if (!/^b3:[0-9a-f]{16}$/.test(key) || typeof full !== "string") throw new Error("Mica: invalid object alias");
		aliases[key] = resolveObjectHash(key, { [key]: full });
	}
	return aliases;
}

export async function bindNoteStore(root: StoreRoot, file: TFile, source: string, options: { write?: boolean } = {}): Promise<NoteStore | null> {
	requireLiveNote(file);
	const id = noteId(source);
	if (id !== null) {
		await assertUnique(root, file, id);
	}
	const storeId = await validateStoreRoot(root, options.write && id !== null);
	if (id === null) return null;
	const paths = notePaths(id);
	const aliases = await readAliases(root, paths.aliases);
	if (root.vault.getAbstractFileByPath(file.path) !== file || noteId(await root.vault.read(file)) !== id)
		throw new Error("Mica: note identity changed before storage binding");
	assertIndexedUnique(stateOf(root), file, id);
	return { root, file, noteId: id, paths, aliases, storeId };
}

export async function ensureNoteStore(root: StoreRoot, file: TFile, source: string): Promise<{ store: NoteStore; source: string }> {
	requireLiveNote(file);
	await validateStoreRoot(root);
	let current = source;
	if (noteId(current) === null) {
		const fresh = newId();
		await assertUnique(root, file, fresh);
		current = await root.vault.process(file, (live) => {
			if (live !== source) throw new Error("Mica: note changed before identity could be prepared");
			return setNoteId(live, null, fresh);
		});
	}
	const store = await bindNoteStore(root, file, current, { write: true });
	if (!store) throw new Error("Mica: note identity could not be prepared");
	return { store, source: current };
}

export async function stageNoteStore(root: StoreRoot, file: TFile, expectedSource: string, id: string): Promise<NoteStore> {
	requireLiveNote(file);
	const paths = notePaths(id);
	await assertUnique(root, file, id);
	const current = await root.vault.read(file);
	if (current !== expectedSource && noteId(current) !== id) throw new Error("Mica: note changed before staging");
	assertIndexedUnique(stateOf(root), file, id);
	const storeId = await validateStoreRoot(root, true);
	return { root, file, noteId: id, paths, aliases: {}, storeId, expectedSource };
}

export async function assertNoteStoreCurrent(store: NoteStore, write = false): Promise<void> {
	requireLiveNote(store.file);
	if (store.root.vault.getAbstractFileByPath(store.file.path) !== store.file) throw new Error("Mica: note was replaced or deleted");
	await assertUnique(store.root, store.file, store.noteId);
	const marker = await validateStoreRoot(store.root, write);
	const aliases = await readAliases(store.root, store.paths.aliases);
	for (const [short, full] of Object.entries(store.aliases)) {
		if (aliases[short] !== full) throw new Error(`Mica: immutable object alias changed: ${short}`);
	}
	Object.assign(store.aliases, aliases);
	if (store.storeId !== null && marker !== store.storeId) throw new Error("Mica: central store identity changed; retry");
	const source = await store.root.vault.read(store.file);
	if (noteId(source) !== store.noteId && source !== store.expectedSource)
		throw new Error("Mica: note identity changed; history was left unchanged");
	assertIndexedUnique(stateOf(store.root), store.file, store.noteId);
}
