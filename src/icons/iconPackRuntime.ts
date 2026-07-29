import { requestUrl } from "obsidian";
import { cdnsFor, packAssetUrl, packIndexUrl, parseIconIndex, type IconPack } from "./iconPacks";
import { isAllowedSvgAttribute, isAllowedSvgElement, looksLikeSvg } from "./svgPolicy";

/**
 * Fetches and rebuilds icons from opt-in packs.
 *
 * Nothing is requested until an enabled pack is actually asked for an icon, and
 * nothing fetched is inserted as markup: every element is rebuilt from an
 * allowlist, so a compromised or malicious CDN response cannot introduce script
 * into the vault. `requestUrl` is used rather than `fetch` so a pack served
 * without permissive CORS still resolves instead of failing opaquely.
 */

/** Whole-set payloads are held once per pack; per-icon results are memoized. */
const MAX_CACHED_ICONS_PER_PACK = 256;

interface PackCache {
	/** Sprite symbols or JSON path data, indexed by icon name. */
	whole: Map<string, string> | null;
	loading: Promise<void> | null;
	icons: Map<string, string>;
	/** Names offered by a per-icon pack's index, once fetched. */
	catalog?: string[];
}

const caches = new Map<string, PackCache>();

function cacheFor(pack: IconPack): PackCache {
	const existing = caches.get(pack.id);
	if (existing) return existing;
	const created: PackCache = { whole: null, loading: null, icons: new Map() };
	caches.set(pack.id, created);
	return created;
}

/** Forget everything a pack loaded — used when a pack is disabled. */
export function forgetIconPack(packId: string): void {
	caches.delete(packId);
}

export function forgetAllIconPacks(): void {
	caches.clear();
}

async function fetchText(pack: IconPack, icon?: string): Promise<string | null> {
	// The primary CDN is tried first; the fallback exists so one host being
	// unreachable does not disable a pack the user turned on.
	for (const cdn of cdnsFor(pack)) {
		const url = packAssetUrl(pack, cdn, icon);
		if (!url) continue;
		try {
			const response = await requestUrl({ url, method: "GET", throw: false });
			if (response.status >= 200 && response.status < 300 && response.text) return response.text;
		} catch {
			// Try the next host rather than failing the whole pack.
		}
	}
	return null;
}

/**
 * Rebuild a fetched SVG through the allowlist.
 *
 * The parsed document is never adopted; a fresh element tree is constructed so
 * nothing unrecognised — attributes, namespaces, or nodes — can ride along.
 */
export function rebuildSvg(markup: string): SVGSVGElement | null {
	if (!looksLikeSvg(markup)) return null;
	const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
	if (parsed.querySelector("parsererror")) return null;
	const root = parsed.documentElement;
	if (!root || root.nodeName.toLowerCase() !== "svg") return null;
	const rebuilt = copyElement(root);
	return rebuilt instanceof SVGSVGElement ? rebuilt : null;
}

function copyElement(source: Element): SVGElement | null {
	const name = source.nodeName;
	if (!isAllowedSvgElement(name)) return null;
	const copy = document.createElementNS("http://www.w3.org/2000/svg", name);
	for (const attribute of Array.from(source.attributes)) {
		if (!isAllowedSvgAttribute(attribute.name, attribute.value)) continue;
		copy.setAttribute(attribute.name, attribute.value);
	}
	for (const child of Array.from(source.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			// Only <title>/<desc> carry meaningful text; elsewhere it is noise.
			if (name === "title" || name === "desc") copy.appendChild(document.createTextNode(child.textContent ?? ""));
			continue;
		}
		if (child.nodeType !== Node.ELEMENT_NODE) continue;
		const rebuilt = copyElement(child as Element);
		if (rebuilt) copy.appendChild(rebuilt);
	}
	return copy;
}

/** Index a sprite's `<symbol>` elements by name. */
function indexWholeSet(payload: string): Map<string, string> {
	const index = new Map<string, string>();
	const parsed = new DOMParser().parseFromString(payload, "image/svg+xml");
	for (const symbol of Array.from(parsed.querySelectorAll("symbol"))) {
		const id = symbol.getAttribute("id");
		if (id)
			index.set(
				id.toLocaleLowerCase(),
				symbol.outerHTML.replace(/^<symbol/i, "<svg").replace(/symbol>$/i, "svg>"),
			);
	}
	return index;
}

async function ensureWholeSet(pack: IconPack): Promise<Map<string, string> | null> {
	const cache = cacheFor(pack);
	if (cache.whole) return cache.whole;
	cache.loading ??= (async () => {
		const payload = await fetchText(pack);
		cache.whole = payload ? indexWholeSet(payload) : new Map();
	})().finally(() => {
		cache.loading = null;
	});
	await cache.loading;
	return cache.whole;
}

/** Every icon name an enabled whole-set pack offers, for the picker's catalog. */
export async function iconPackCatalog(pack: IconPack): Promise<string[]> {
	if (pack.source.kind === "per-icon") {
		// A per-icon pack is browsable only if it publishes a name index; the
		// artwork itself still loads one icon at a time.
		const cache = cacheFor(pack);
		if (cache.catalog) return cache.catalog;
		const names: string[] = [];
		for (const cdn of cdnsFor(pack)) {
			const url = packIndexUrl(pack, cdn);
			if (!url) continue;
			try {
				const response = await requestUrl({ url, method: "GET", throw: false });
				if (response.status >= 200 && response.status < 300 && response.text) {
					names.push(...parseIconIndex(response.text));
					break;
				}
			} catch {
				// Fall through to the next host.
			}
		}
		cache.catalog = names.sort((left, right) => left.localeCompare(right));
		return cache.catalog;
	}
	const whole = await ensureWholeSet(pack);
	return whole ? [...whole.keys()].sort((left, right) => left.localeCompare(right)) : [];
}

/** A sanitized icon element, or null when the pack cannot supply that name. */
export async function loadPackIcon(pack: IconPack, icon: string): Promise<SVGSVGElement | null> {
	const cache = cacheFor(pack);
	const key = icon.toLocaleLowerCase();
	const cached = cache.icons.get(key);
	if (cached !== undefined) return rebuildSvg(cached);
	let markup: string | null = null;
	if (pack.source.kind === "per-icon") markup = await fetchText(pack, icon);
	else markup = (await ensureWholeSet(pack))?.get(key) ?? null;
	if (markup === null) return null;
	cache.icons.set(key, markup);
	// Bounded: a long session browsing a large pack must not grow without end.
	while (cache.icons.size > MAX_CACHED_ICONS_PER_PACK) {
		const oldest = cache.icons.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		cache.icons.delete(oldest);
	}
	return rebuildSvg(markup);
}
