/**
 * Optional icon packs, described as data.
 *
 * Adding a pack is one entry here; updating one is a single version string.
 * Nothing is enabled or fetched until the user asks for it, and nothing is
 * bundled — the plugin ships no third-party icon artwork.
 *
 * Packs differ in how a whole set is obtained: some publish one sprite or one
 * JSON map, some only individual files. That difference is in the data rather
 * than in the code that consumes it.
 */

export type IconPackSource =
	/** One request yields every icon as `<symbol id="…">`. */
	| { readonly kind: "svg-sprite"; readonly file: string }
	/**
	 * No combined artwork artifact exists; `{icon}` is replaced per request.
	 *
	 * `indexFile` names an optional small JSON list of icon names. Without it a
	 * pack cannot be browsed — only reached by typing an id — so a pack that
	 * publishes one is searchable while still loading artwork one icon at a time.
	 */
	| { readonly kind: "per-icon"; readonly file: string; readonly indexFile?: string };

export interface IconPackLicense {
	readonly spdx: string;
	readonly url: string;
	/** Present when the licence requires visible credit wherever icons appear. */
	readonly attribution?: string;
	/** Anything a reviewer or maintainer must know beyond the SPDX id. */
	readonly note?: string;
}

export interface IconPack {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	/** `npm` packs can fall back to a second CDN; `gh` packs are jsDelivr-only. */
	readonly host: "npm" | "gh";
	/** npm package name, or `owner/repo` for GitHub-hosted packs. */
	readonly slug: string;
	readonly license: IconPackLicense;
	readonly source: IconPackSource;
	/** Uncompressed bytes of the whole-set payload; 0 when fetched per icon. */
	readonly approxBytes: number;
}

/**
 * Version-pinned paths on these hosts are immutable and send permissive CORS,
 * so a pinned URL keeps resolving without maintenance. GitHub raw is cached for
 * five minutes and rate-limited, and release assets send no CORS at all and
 * redirect to a short-lived signed URL — neither is a stable source.
 */
export const CDN_BASES = {
	jsdelivr: "https://cdn.jsdelivr.net",
	unpkg: "https://unpkg.com",
} as const;

export type CdnId = keyof typeof CDN_BASES;

export const ICON_PACKS: readonly IconPack[] = [
	{
		id: "bootstrap-icons",
		name: "Bootstrap Icons",
		version: "1.13.1",
		host: "npm",
		slug: "bootstrap-icons",
		license: { spdx: "MIT", url: "https://github.com/twbs/icons/blob/main/LICENSE" },
		source: { kind: "svg-sprite", file: "bootstrap-icons.svg" },
		approxBytes: 1_123_048,
	},
	{
		id: "tabler",
		name: "Tabler Icons",
		version: "3.35.0",
		host: "npm",
		slug: "@tabler/icons-sprite",
		license: { spdx: "MIT", url: "https://github.com/tabler/tabler-icons/blob/main/LICENSE" },
		source: { kind: "svg-sprite", file: "dist/tabler-sprite.svg" },
		approxBytes: 2_166_896,
	},
	{
		id: "simple-icons",
		name: "Simple Icons (brands)",
		version: "16.27.1",
		host: "npm",
		slug: "simple-icons",
		license: {
			spdx: "CC0-1.0",
			url: "https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md",
			note: "CC0 covers the artwork; the depicted trademarks remain their owners'.",
		},
		// The JSON is a name index, not artwork: entries carry `slug`/`title` but
		// no path data, so the icons themselves come from `icons/<slug>.svg`.
		source: { kind: "per-icon", file: "icons/{icon}.svg", indexFile: "data/simple-icons.json" },
		approxBytes: 0,
	},
	{
		id: "iconoir",
		name: "Iconoir",
		version: "7.11.0",
		host: "npm",
		slug: "iconoir",
		license: { spdx: "MIT", url: "https://github.com/iconoir-icons/iconoir/blob/main/LICENSE" },
		source: { kind: "per-icon", file: "icons/regular/{icon}.svg" },
		approxBytes: 0,
	},
	{
		id: "twemoji",
		name: "Twemoji",
		version: "17.0.3",
		host: "gh",
		slug: "jdecked/twemoji",
		license: {
			spdx: "CC-BY-4.0",
			url: "https://github.com/jdecked/twemoji/blob/main/LICENSE-GRAPHICS",
			attribution: "Emoji artwork by Twemoji, licensed CC-BY 4.0",
		},
		// Twemoji publishes no sprite or atlas, so a whole-set fetch would be
		// thousands of requests. Icons load individually, on use.
		source: { kind: "per-icon", file: "assets/svg/{icon}.svg" },
		approxBytes: 0,
	},
] as const;

export function findIconPack(id: string): IconPack | null {
	return ICON_PACKS.find((pack) => pack.id === id) ?? null;
}

export type EnabledIconPackIds = readonly string[] | ReadonlySet<string>;

/** A setting entry enables only a pack that the pinned manifest still knows. */
export function isIconPackEnabled(packId: string, enabledPackIds: EnabledIconPackIds): boolean {
	if (!findIconPack(packId)) return false;
	return "has" in enabledPackIds ? enabledPackIds.has(packId) : enabledPackIds.includes(packId);
}

/** GitHub-hosted packs exist only on jsDelivr; unpkg serves npm alone. */
export function cdnsFor(pack: IconPack): CdnId[] {
	return pack.host === "npm" ? ["jsdelivr", "unpkg"] : ["jsdelivr"];
}

/**
 * The URL for a pack's payload.
 *
 * @param icon - required for `per-icon` packs, ignored otherwise.
 */
export function packAssetUrl(pack: IconPack, cdn: CdnId, icon?: string): string | null {
	if (pack.host === "gh" && cdn !== "jsdelivr") return null;
	let file = pack.source.file;
	if (pack.source.kind === "per-icon") {
		// An id reaching the URL unchecked would let a crafted name escape the
		// pinned package path.
		if (!icon || !/^[a-z0-9][a-z0-9._-]*$/i.test(icon)) return null;
		file = file.replace("{icon}", icon);
	}
	// The two hosts do not share a path shape: jsDelivr namespaces by registry
	// (`/npm/`, `/gh/`), unpkg serves npm at the root and has no GitHub mode.
	const prefix = cdn === "unpkg" ? "" : pack.host === "npm" ? "npm/" : "gh/";
	return `${CDN_BASES[cdn]}/${prefix}${pack.slug}@${pack.version}/${file}`;
}

/** URL of a per-icon pack's name index, when it publishes one. */
export function packIndexUrl(pack: IconPack, cdn: CdnId): string | null {
	if (pack.source.kind !== "per-icon" || !pack.source.indexFile) return null;
	if (pack.host === "gh" && cdn !== "jsdelivr") return null;
	const prefix = cdn === "unpkg" ? "" : pack.host === "npm" ? "npm/" : "gh/";
	return `${CDN_BASES[cdn]}/${prefix}${pack.slug}@${pack.version}/${pack.source.indexFile}`;
}

/** Icon names from a pack's index payload. Entries name themselves with `slug`
 * or `title`; anything else is not a name this pack can be asked for. */
export function parseIconIndex(payload: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed : ((parsed as { icons?: unknown[] }).icons ?? []);
	const names: string[] = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			names.push(entry);
			continue;
		}
		const icon = entry as { slug?: unknown; title?: unknown };
		const name = typeof icon.slug === "string" ? icon.slug : typeof icon.title === "string" ? icon.title : null;
		if (name) names.push(name);
	}
	return names;
}

/** Credit that must be shown wherever the enabled packs' icons appear. */
export function requiredAttribution(enabled: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const id of enabled) {
		const credit = findIconPack(id)?.license.attribution;
		if (credit) seen.add(credit);
	}
	return [...seen];
}

/** Bytes a set of enabled packs would hold once fully loaded. */
export function estimatedBytes(enabled: readonly string[]): number {
	return enabled.reduce((total, id) => total + (findIconPack(id)?.approxBytes ?? 0), 0);
}

/** Pack icons are namespaced `packId:iconName` so they stay distinguishable
 * from Obsidian's built-in ids in stored block titles, and remain readable even
 * if the pack is later disabled. */
const NAMESPACE = ":";

export function packIconId(packId: string, icon: string): string {
	return `${packId}${NAMESPACE}${icon}`;
}

export function splitPackIconId(id: string): { packId: string; icon: string } | null {
	const at = id.indexOf(NAMESPACE);
	if (at <= 0) return null;
	const icon = id.slice(at + 1);
	if (!icon) return null;
	const packId = id.slice(0, at);
	return findIconPack(packId) ? { packId, icon } : null;
}

/**
 * Offer one exact typed id for an enabled per-icon pack that has no catalog.
 *
 * This is only query policy: the runtime loader remains the authority on
 * whether artwork exists. URL validation here prevents malformed names from
 * becoming buttons that could escape the pack's pinned asset path.
 */
export function exactPackIconCandidate(query: string, enabledPackIds: ReadonlySet<string>): string | null {
	const id = query.trim();
	const parts = splitPackIconId(id);
	if (!parts || !enabledPackIds.has(parts.packId)) return null;
	const pack = findIconPack(parts.packId);
	if (!pack || pack.source.kind !== "per-icon" || pack.source.indexFile) return null;
	return packAssetUrl(pack, "jsdelivr", parts.icon) ? id : null;
}

export function isPackIconId(id: string): boolean {
	return splitPackIconId(id) !== null;
}
