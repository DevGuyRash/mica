import { TFile, TFolder, type Vault } from "obsidian";
import {
	isManagedPath, newId, noteId, notePaths, resolveObjectHash, setNoteId, storageLayout, validateStoreLocation, validateStoreMarker,
	type NotePaths, type StorageLayout, type StoreLocation,
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
interface StoreFileGeneration {
	readonly file: TFile | null;
	readonly mtime: number | null;
	readonly size: number | null;
}
interface StoreState {
	readonly root: StoreRoot;
	location: StoreLocation | null;
	locationGeneration: StoreFileGeneration | null;
	markerGeneration: StoreFileGeneration | null;
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

export const MAX_STORE_LOCATION_BYTES = 16 * 1024;
export const MAX_STORE_MARKER_BYTES = 4096;
export type { StoreLocation } from "../wasm/bridge";

export interface StoreLocationSnapshot {
	readonly location: StoreLocation | null;
	readonly text: string | null;
	readonly file: TFile | null;
	readonly mtime: number | null;
	readonly size: number | null;
}

function createState(vault: Vault, location: StoreLocation | null): StoreState {
	const root = Object.freeze({ vault, paths: Object.freeze(storageLayout(location?.folder)) });
	return { root, location, locationGeneration: null, markerGeneration: null, identities: new Map(), byId: new Map(), errors: new Set(), pending: new Map(), dirty: new Set(),
		revisions: new Map(), indexed: null, initializing: null, disposed: false, epoch: 0, legacyPresent: null, owner: null };
}

/** Startup owns route changes; replacing the configured root invalidates every old handle. */
export function configureStoreRoot(vault: Vault, location: StoreLocation | null): StoreRoot {
	const validated = location === null ? null : Object.freeze(validateStoreLocation(location));
	const old = roots.get(vault);
	if (old) {
		old.disposed = true;
		old.epoch += 1;
		old.identities.clear(); old.byId.clear(); old.errors.clear(); old.dirty.clear(); old.revisions.clear();
	}
	const state = createState(vault, validated);
	roots.set(vault, state);
	return state.root;
}

export function storeRoot(vault: Vault): StoreRoot {
	const state = roots.get(vault);
	return state?.root ?? configureStoreRoot(vault, null);
}

function ownedState(root: StoreRoot): StoreState {
	const state = roots.get(root.vault);
	if (!state || state.root !== root || state.disposed) throw new Error("Mica: storage root changed; retry after startup completes");
	return state;
}

function assertFileGeneration(root: StoreRoot, path: string, generation: StoreFileGeneration | null): void {
	if (generation === null) return; // No authority has been read yet; this does not admit a write.
	const file = root.vault.getAbstractFileByPath(path);
	if (file !== generation.file || (generation.file !== null &&
		(generation.file.path !== path || generation.file.stat.mtime !== generation.mtime || generation.file.stat.size !== generation.size)))
		throw new Error("Mica: storage authority changed after validation; restart before using history");
}

function stateOf(root: StoreRoot, allowInitializing = false): StoreState {
	const state = ownedState(root);
	if (state.location?.previousFolder != null) throw new Error("Mica: storage relocation is pending; ordinary history operations are disabled");
	if (state.location?.initializing && !allowInitializing) throw new Error("Mica: storage initialization is pending; startup recovery is required");
	if (root.paths.root !== storageLayout().root && root.vault.getAbstractFileByPath(storageLayout().root))
		throw new Error("Mica: the reserved default storage folder conflicts with the selected location");
	if (state.location !== null && state.location.storeId === null && root.vault.getAbstractFileByPath(root.paths.root))
		throw new Error("Mica: an uninitialized storage location cannot adopt an existing directory");
	assertFileGeneration(root, root.paths.location, state.locationGeneration);
	assertFileGeneration(root, root.paths.marker, state.markerGeneration);
	return state;
}

/** Wait only for this host's owned transaction; persisted external intent stays blocked. */
async function ordinaryState(root: StoreRoot): Promise<StoreState> {
	const state = ownedState(root);
	if (state.initializing) {
		await state.initializing;
		return ordinaryState(root);
	}
	return stateOf(root);
}

/** Synchronous final guard for effects admitted after an asynchronous validation. */
export function assertStoreRootCurrent(root: StoreRoot): void {
	stateOf(root);
}

function sameLocation(left: StoreLocation | null, right: StoreLocation | null): boolean {
	return left === null || right === null ? left === right :
		left.format === right.format && left.folder === right.folder && left.storeId === right.storeId && left.previousFolder === right.previousFolder && left.initializing === right.initializing;
}

/** Missing locator reads retain the default-root compatibility lookup without creating anything. */
export async function readStoreLocation(vault: Vault): Promise<StoreLocationSnapshot> {
	const path = storageLayout().location;
	const file = vault.getAbstractFileByPath(path);
	if (!file) return { location: null, text: null, file: null, mtime: null, size: null };
	if (!(file instanceof TFile) || file.stat.size > MAX_STORE_LOCATION_BYTES) throw new Error("Mica: invalid storage location document");
	const mtime = file.stat.mtime, size = file.stat.size;
	const text = await vault.read(file);
	if (vault.getAbstractFileByPath(path) !== file || file.stat.mtime !== mtime || file.stat.size !== size)
		throw new Error("Mica: storage location changed while being read; retry");
	if (new TextEncoder().encode(text).byteLength > MAX_STORE_LOCATION_BYTES) throw new Error("Mica: storage location document is too large");
	return { location: Object.freeze(validateStoreLocation(JSON.parse(text) as unknown)), text, file, mtime, size };
}

async function publishStoreLocation(vault: Vault, expected: StoreLocationSnapshot, location: StoreLocation, guard?: () => void, ownedRoot?: StoreRoot): Promise<StoreLocationSnapshot> {
	const validated = validateStoreLocation(location);
	const body = JSON.stringify(validated, null, "\t") + "\n";
	if (new TextEncoder().encode(body).byteLength > MAX_STORE_LOCATION_BYTES) throw new Error("Mica: storage location document is too large");
	const path = storageLayout().location;
	const publicationState = ownedRoot ? ownedState(ownedRoot) : undefined;
	guard?.();
	if (vault.getAbstractFileByPath(path) !== expected.file) throw new Error("Mica: storage location was replaced before publication; retry");
	if (expected.file) {
		if (expected.file.path !== path || expected.text === null) throw new Error("Mica: invalid storage location preimage");
		await vault.process(expected.file, (current) => {
			guard?.();
			if (vault.getAbstractFileByPath(path) !== expected.file || current !== expected.text)
				throw new Error("Mica: storage location changed before publication; retry");
			return body;
		});
	} else {
		if (expected.text !== null || expected.location !== null) throw new Error("Mica: invalid missing storage location preimage");
		guard?.();
		await vault.create(path, body);
	}
	const published = await readStoreLocation(vault);
	if (published.text !== body || !sameLocation(published.location, validated)) throw new Error("Mica: storage location publication could not be verified");
	if (publicationState && !publicationState.disposed) {
		if (roots.get(vault) !== publicationState) throw new Error("Mica: storage owner changed during locator publication");
		assertFileGeneration(publicationState.root, publicationState.root.paths.marker, publicationState.markerGeneration);
		// Only this exact verified publication may advance an owned locator generation.
		publicationState.locationGeneration = { file: published.file, mtime: published.mtime, size: published.size };
	}
	if (ownedRoot) guard?.();
	return published;
}

/** Controller guard runs before effects and inside process; the locator postimage is then verified. */
export function writeStoreLocation(vault: Vault, expected: StoreLocationSnapshot, location: StoreLocation, guard?: () => void): Promise<StoreLocationSnapshot> {
	return publishStoreLocation(vault, expected, location, guard);
}

async function assertRouteCurrent(root: StoreRoot, requireClaim = false, allowInitializing = false): Promise<StoreLocationSnapshot> {
	const before = allowInitializing ? stateOf(root, true) : await ordinaryState(root);
	const location = before.location;
	let snapshot: StoreLocationSnapshot;
	try { snapshot = await readStoreLocation(root.vault); }
	catch (error) {
		const owner = ownedState(root);
		if (!allowInitializing && (owner.initializing || owner.location !== location)) {
			await ordinaryState(root);
			return assertRouteCurrent(root, requireClaim);
		}
		throw error;
	}
	const owner = ownedState(root);
	if (!allowInitializing && (owner.initializing || owner.location !== location)) {
		await ordinaryState(root);
		return assertRouteCurrent(root, requireClaim);
	}
	const state = stateOf(root, allowInitializing);
	if (!sameLocation(state.location, snapshot.location) || (snapshot.location?.folder ?? storageLayout().root) !== root.paths.root)
		throw new Error("Mica: storage location differs from the configured root; restart before using history");
	if (snapshot.location?.previousFolder != null) throw new Error("Mica: storage relocation is pending");
	if (requireClaim && snapshot.location === null) throw new Error("Mica: storage location must be claimed before creating managed folders");
	const generation = { file: snapshot.file, mtime: snapshot.mtime, size: snapshot.size };
	assertFileGeneration(root, root.paths.location, generation);
	state.locationGeneration = generation;
	return snapshot;
}

export function isLiveNote(file: TFile): boolean {
	const root = storeRoot(file.vault);
	const previous = roots.get(file.vault)?.location?.previousFolder;
	return file.extension.toLowerCase() === "md" && !file.path.includes(".mica/") && !isManagedPath(file.path, root.paths.root) &&
		(previous == null || !isManagedPath(file.path, previous));
}

function requireLiveNote(file: TFile): void {
	if (!isLiveNote(file)) throw new Error(`Mica: managed storage is not a live note: ${file.path}`);
}

/** Pin both route authority and the selected live note at the publication boundary. */
export function assertLiveNoteCurrent(root: StoreRoot, file: TFile, expectedPath: string): void {
	assertStoreRootCurrent(root);
	if (file.vault !== root.vault || file.path !== expectedPath || root.vault.getAbstractFileByPath(expectedPath) !== file)
		throw new Error("Mica: the selected note changed before publication; retry");
	requireLiveNote(file);
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
	const state = await ordinaryState(root);
	for (const file of state.errors) if (root.vault.getAbstractFileByPath(file.path) === file && isLiveNote(file)) state.dirty.add(file);
	if (state.disposed) throw new Error("Mica: storage identity owner is disposed");
	await identityIndex(state);
	for (let attempt = 0; attempt < 3; attempt++) {
		for (const changed of [...state.dirty]) { if (!state.dirty.delete(changed)) continue; if (isLiveNote(changed) && root.vault.getAbstractFileByPath(changed.path) === changed) await refreshIdentity(state, changed); }
		await Promise.all(state.pending.values());
		if (!state.dirty.size && !state.pending.size) break;
	}
	if (state.pending.size) throw new Error("Mica: note identities are changing; retry after the vault settles");
	assertIndexedUnique(await ordinaryState(root), file, id);
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

export function ensureStoreFolder(root: StoreRoot, path: string): Promise<void> {
	return ensureSelectedFolder(root, path);
}

async function ensureSelectedFolder(root: StoreRoot, path: string, allowInitializing = false): Promise<void> {
	stateOf(root, allowInitializing);
	if (!isManagedPath(path, root.paths.root) || !(path === root.paths.root || path.startsWith(`${root.paths.root}/`)) || path.includes("\\") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path))
		throw new Error("Mica: storage folder escapes the selected root");
	let parent = "";
	for (const part of path.split("/")) {
		parent = parent ? `${parent}/${part}` : part;
		const current = root.vault.getAbstractFileByPath(parent);
		if (current instanceof TFolder) continue;
		if (current) throw new Error(`Mica: storage path is not a folder: ${parent}`);
		await assertRouteCurrent(root, true, allowInitializing);
		stateOf(root, allowInitializing);
		try { await root.vault.createFolder(parent); }
		catch (error) { if (!(root.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error; }
		stateOf(root, allowInitializing);
	}
}

async function readStoreMarker(root: StoreRoot, file: TFile, expectedText?: string, allowInitializing = false): Promise<string> {
	if (file.stat.size > MAX_STORE_MARKER_BYTES) throw new Error("Mica: invalid central store marker");
	const mtime = file.stat.mtime, size = file.stat.size;
	const text = await root.vault.read(file);
	const state = allowInitializing ? stateOf(root, true) : await ordinaryState(root);
	if (root.vault.getAbstractFileByPath(root.paths.marker) !== file || file.stat.mtime !== mtime || file.stat.size !== size || new TextEncoder().encode(text).byteLength > MAX_STORE_MARKER_BYTES)
		throw new Error("Mica: central store marker changed while being read");
	if (expectedText !== undefined && text !== expectedText) throw new Error("Mica: owned store marker preimage changed during initialization");
	const id = validateStoreMarker(JSON.parse(text) as unknown).storeId;
	state.markerGeneration = { file, mtime, size };
	return id;
}

async function completeStoreInitialization(root: StoreRoot): Promise<void> {
	let snapshot = await assertRouteCurrent(root, true, true);
	const intent = snapshot.location;
	if (intent === null || !intent.initializing || intent.storeId === null)
		throw new Error("Mica: no recorded store initialization intent is available");
	let marker = root.vault.getAbstractFileByPath(root.paths.marker);
	const folder = root.vault.getAbstractFileByPath(root.paths.root);
	if (folder && !(folder instanceof TFolder)) throw new Error("Mica: selected storage directory is not a folder");
	if (!marker) {
		if (folder instanceof TFolder && folder.children.length !== 0)
			throw new Error("Mica: pending initialization names a populated directory without its marker");
		await ensureSelectedFolder(root, root.paths.root, true);
		await assertRouteCurrent(root, true, true);
		const empty = root.vault.getAbstractFileByPath(root.paths.root);
		if (!(empty instanceof TFolder) || empty.children.length !== 0 || root.vault.getAbstractFileByPath(root.paths.marker))
			throw new Error("Mica: selected storage directory changed before marker creation");
		const body = JSON.stringify({ format: root.paths.format, storeId: intent.storeId }, null, "\t") + "\n";
		stateOf(root, true);
		try { marker = await root.vault.create(root.paths.marker, body); }
		catch (error) {
			// An ambiguous own create may only recover the exact recorded marker body.
			const candidate = root.vault.getAbstractFileByPath(root.paths.marker);
			if (!(candidate instanceof TFile)) throw error;
			// Pending intent excludes ordinary callers while the owned body is verified.
			ownedState(root).markerGeneration = { file: candidate, mtime: candidate.stat.mtime, size: candidate.stat.size };
			await readStoreMarker(root, candidate, body, true);
			marker = candidate;
		}
		if (!(marker instanceof TFile)) throw new Error("Mica: invalid initialized store marker");
		ownedState(root).markerGeneration = { file: marker, mtime: marker.stat.mtime, size: marker.stat.size };
		await readStoreMarker(root, marker, body, true);
	}
	if (!(marker instanceof TFile) || await readStoreMarker(root, marker, undefined, true) !== intent.storeId)
		throw new Error("Mica: pending initialization marker differs from its recorded identity");
	const pinnedMarker = marker;
	const initializedFolder = root.vault.getAbstractFileByPath(root.paths.root);
	const requireInitializationLeaf = (): void => {
		if (!(initializedFolder instanceof TFolder) || root.vault.getAbstractFileByPath(root.paths.root) !== initializedFolder ||
			initializedFolder.children.length !== 1 || initializedFolder.children[0] !== pinnedMarker)
			throw new Error("Mica: pending initialization contains unexpected storage entries");
	};
	requireInitializationLeaf();
	const markerMtime = pinnedMarker.stat.mtime, markerSize = pinnedMarker.stat.size;
	snapshot = await assertRouteCurrent(root, true, true);
	if (!sameLocation(snapshot.location, intent)) throw new Error("Mica: store initialization intent changed before completion");
	const published = await publishStoreLocation(root.vault, snapshot, { ...intent, initializing: false }, () => {
		stateOf(root, true);
		requireInitializationLeaf();
		if (root.vault.getAbstractFileByPath(root.paths.marker) !== pinnedMarker || pinnedMarker.stat.mtime !== markerMtime || pinnedMarker.stat.size !== markerSize)
			throw new Error("Mica: initialization marker changed before locator completion");
	}, root);
	stateOf(root, true).location = published.location;
}

/** Startup-only recovery: resume the sole persisted initialization intent, never infer one. */
export async function resumeStoreInitialization(root: StoreRoot): Promise<void> {
	const state = stateOf(root, true);
	if (!state.location?.initializing) throw new Error("Mica: no pending store initialization was recorded");
	if (state.initializing) { await state.initializing; return; }
	const initialize = completeStoreInitialization(root);
	state.initializing = initialize;
	try { await initialize; } finally { if (state.initializing === initialize) state.initializing = null; }
	await validateStoreRoot(root);
}

async function initializeStoreRoot(root: StoreRoot, expected: StoreLocationSnapshot, existingId: string | null): Promise<void> {
	if (existingId !== null) {
		if (expected.location !== null) throw new Error("Mica: only an unlocated default store may be adopted");
		const location: StoreLocation = { format: root.paths.format, folder: root.paths.root, storeId: existingId, previousFolder: null, initializing: false };
		const published = await publishStoreLocation(root.vault, expected, location, () => assertStoreRootCurrent(root), root);
		stateOf(root).location = published.location;
		const file = root.vault.getAbstractFileByPath(root.paths.marker);
		if (!(file instanceof TFile) || await readStoreMarker(root, file, undefined, true) !== existingId) throw new Error("Mica: default store identity changed during locator adoption");
		await assertRouteCurrent(root, true, true);
		return;
	}
	const folder = root.vault.getAbstractFileByPath(root.paths.root);
	if (folder || root.vault.getAbstractFileByPath(root.paths.marker))
		throw new Error("Mica: selected storage directory is not uninitialized");
	const intent: StoreLocation = { format: root.paths.format, folder: root.paths.root, storeId: newId(), previousFolder: null, initializing: true };
	const published = await publishStoreLocation(root.vault, expected, intent, () => assertStoreRootCurrent(root), root);
	stateOf(root, true).location = published.location;
	await completeStoreInitialization(root);
}

/** Every lookup revalidates the sole route authority; only writes may claim an uninitialized store. */
export async function validateStoreRoot(root: StoreRoot, write = false): Promise<string | null> {
	const state = await ordinaryState(root);
	let snapshot = await assertRouteCurrent(root);
	const folder = root.vault.getAbstractFileByPath(root.paths.root);
	const marker = root.vault.getAbstractFileByPath(root.paths.marker);
	if (folder && !(folder instanceof TFolder)) throw new Error("Mica: central store root is not a folder");
	let storeId: string | null = null;
	if (marker) {
		if (!(marker instanceof TFile)) throw new Error("Mica: invalid central store marker");
		storeId = await readStoreMarker(root, marker);
		snapshot = await assertRouteCurrent(root);
		if (snapshot.location !== null && snapshot.location.storeId === null)
			throw new Error("Mica: unpinned location names an initialized directory; startup recovery is required");
		if (snapshot.location?.storeId != null && snapshot.location.storeId !== storeId) throw new Error("Mica: central store identity differs from mica.json");
		if (!write || snapshot.location !== null) return storeId;
	} else {
		state.markerGeneration = { file: null, mtime: null, size: null };
		if (snapshot.location?.storeId != null || folder)
			throw new Error("Mica: central store marker is missing; an explicit offline cutover is required");
		state.legacyPresent ??= root.vault.getAllLoadedFiles().some((file) => file instanceof TFolder && file.path.endsWith(".mica") && !isManagedPath(file.path, root.paths.root));
		if (state.legacyPresent) throw new Error("Mica: legacy sidecars require an explicit offline cutover before central storage can be used");
		if (!write) return null;
	}
	// Concurrent first writers share one claim/marker transaction within this host.
	if (state.initializing) { await state.initializing; return validateStoreRoot(root); }
	const initialize = initializeStoreRoot(root, snapshot, storeId);
	state.initializing = initialize;
	try { await initialize; } finally { if (state.initializing === initialize) state.initializing = null; }
	return validateStoreRoot(root);
}

export const MAX_ALIAS_BYTES = 1024 * 1024;
export const MAX_ALIASES = 16384;

export async function readAliases(root: StoreRoot, path: string): Promise<Record<string, string>> {
	await ordinaryState(root);
	const file = root.vault.getAbstractFileByPath(path);
	if (!file) return {};
	if (!(file instanceof TFile) || file.stat.size > MAX_ALIAS_BYTES) throw new Error(`Mica: invalid alias document: ${path}`);
	const text = await root.vault.read(file);
	await ordinaryState(root);
	return parseAliases(text);
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
	const path = file.path;
	const id = noteId(source);
	if (id !== null) {
		await assertUnique(root, file, id);
	}
	const storeId = await validateStoreRoot(root, options.write && id !== null);
	if (id === null) return null;
	const paths = notePaths(id, root.paths.root);
	const aliases = await readAliases(root, paths.aliases);
	if (root.vault.getAbstractFileByPath(file.path) !== file || noteId(await root.vault.read(file)) !== id)
		throw new Error("Mica: note identity changed before storage binding");
	assertLiveNoteCurrent(root, file, path);
	assertIndexedUnique(stateOf(root), file, id);
	return { root, file, noteId: id, paths, aliases, storeId };
}

export async function ensureNoteStore(root: StoreRoot, file: TFile, source: string): Promise<{ store: NoteStore; source: string }> {
	requireLiveNote(file);
	const path = file.path;
	await validateStoreRoot(root);
	let current = source;
	if (noteId(current) === null) {
		const fresh = newId();
		await assertUnique(root, file, fresh);
		if (root.vault.getAbstractFileByPath(file.path) !== file || await root.vault.read(file) !== source)
			throw new Error("Mica: note changed before storage could be claimed");
		assertIndexedUnique(stateOf(root), file, fresh);
		// Claim/pin the route only after the full identity/live preflight, before stamping source.
		await validateStoreRoot(root, true);
		assertStoreRootCurrent(root);
		current = await root.vault.process(file, (live) => {
			assertLiveNoteCurrent(root, file, path);
			assertIndexedUnique(stateOf(root), file, fresh);
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
	const path = file.path;
	const paths = notePaths(id, root.paths.root);
	await assertUnique(root, file, id);
	const current = await root.vault.read(file);
	if (current !== expectedSource && noteId(current) !== id) throw new Error("Mica: note changed before staging");
	assertIndexedUnique(stateOf(root), file, id);
	const storeId = await validateStoreRoot(root, true);
	assertLiveNoteCurrent(root, file, path);
	return { root, file, noteId: id, paths, aliases: {}, storeId, expectedSource };
}

export async function assertNoteStoreCurrent(store: NoteStore, write = false): Promise<void> {
	requireLiveNote(store.file);
	const path = store.file.path;
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
	assertLiveNoteCurrent(store.root, store.file, path);
	assertIndexedUnique(stateOf(store.root), store.file, store.noteId);
}
