import assert from "node:assert/strict";
import {
	cdnsFor,
	estimatedBytes,
	exactPackIconCandidate,
	findIconPack,
	ICON_PACKS,
	isIconPackEnabled,
	isPackIconId,
	packAssetUrl,
	packIconId,
	packIndexUrl,
	parseIconIndex,
	requiredAttribution,
	splitPackIconId,
} from "../src/icons/iconPacks.ts";
import { isAllowedSvgAttribute, isAllowedSvgElement, looksLikeSvg } from "../src/icons/svgPolicy.ts";

// --- the manifest is data, and stays internally consistent -------------------

assert.equal(new Set(ICON_PACKS.map((pack) => pack.id)).size, ICON_PACKS.length, "pack ids are unique");
for (const pack of ICON_PACKS) {
	assert.ok(pack.version.length > 0, `${pack.id} pins a version`);
	assert.ok(pack.license.spdx.length > 0, `${pack.id} names its licence`);
	assert.ok(pack.license.url.startsWith("https://"), `${pack.id} links its licence`);
	assert.equal(
		pack.source.kind === "per-icon",
		pack.source.file.includes("{icon}"),
		`${pack.id}: only per-icon sources interpolate an icon name`,
	);
	assert.equal(
		pack.source.kind === "per-icon",
		pack.approxBytes === 0,
		`${pack.id}: a whole-set payload declares its size, a per-icon one cannot`,
	);
}

// --- URLs are version-pinned, and a version bump is one string --------------

const bootstrap = findIconPack("bootstrap-icons")!;
assert.equal(
	packAssetUrl(bootstrap, "jsdelivr"),
	"https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/bootstrap-icons.svg",
);
assert.equal(
	packAssetUrl(bootstrap, "unpkg"),
	"https://unpkg.com/bootstrap-icons@1.13.1/bootstrap-icons.svg",
	"unpkg serves npm at the root — the jsDelivr `/npm/` prefix 404s there",
);
assert.deepEqual(cdnsFor(bootstrap), ["jsdelivr", "unpkg"]);

const twemoji = findIconPack("twemoji")!;
assert.equal(
	packAssetUrl(twemoji, "jsdelivr", "1f600"),
	"https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/svg/1f600.svg",
);
assert.deepEqual(cdnsFor(twemoji), ["jsdelivr"], "GitHub-hosted packs have no unpkg fallback");
assert.equal(packAssetUrl(twemoji, "unpkg", "1f600"), null, "and must not silently resolve to one");

// A per-icon pack needs a name, and that name must not be able to leave the
// pinned package path.
assert.equal(packAssetUrl(twemoji, "jsdelivr"), null, "a per-icon pack needs an icon");
for (const hostile of ["../../etc/passwd", "a/b", "..", "", "with space", "%2e%2e/x"]) {
	assert.equal(packAssetUrl(twemoji, "jsdelivr", hostile), null, `refuses ${JSON.stringify(hostile)}`);
}
assert.ok(packAssetUrl(twemoji, "jsdelivr", "1f1e6-1f1e8"), "ordinary emoji ids are accepted");

// --- attribution and size are derived from the enabled set ------------------

assert.deepEqual(
	requiredAttribution(["twemoji", "bootstrap-icons"]),
	["Emoji artwork by Twemoji, licensed CC-BY 4.0"],
	"a pack whose licence requires credit contributes it; permissive packs do not",
);
assert.deepEqual(requiredAttribution(["bootstrap-icons"]), []);
assert.deepEqual(requiredAttribution(["nonexistent"]), []);
assert.equal(estimatedBytes(["bootstrap-icons"]), 1_123_048);

// --- an indexed per-icon pack is browsable without downloading its artwork ---

const simple = findIconPack("simple-icons")!;
assert.equal(
	packIndexUrl(simple, "jsdelivr"),
	"https://cdn.jsdelivr.net/npm/simple-icons@16.27.1/data/simple-icons.json",
	"the index is a small name list, fetched separately from any artwork",
);
assert.equal(
	packAssetUrl(simple, "jsdelivr", "github"),
	"https://cdn.jsdelivr.net/npm/simple-icons@16.27.1/icons/github.svg",
	"artwork still loads one icon at a time",
);
assert.equal(packIndexUrl(bootstrap, "jsdelivr"), null, "a sprite pack needs no separate index");

// The real payload is an array of entries naming themselves with `slug`; the
// same file carries no path data, which is why it cannot be the artwork source.
assert.deepEqual(
	parseIconIndex('[{"title":".ENV","slug":"dotenv","hex":"ECD53F"},{"title":"GitHub","slug":"github"}]'),
	["dotenv", "github"],
);
assert.deepEqual(parseIconIndex('{"icons":[{"title":"Only Title"}]}'), ["Only Title"]);
assert.deepEqual(parseIconIndex('["plain","names"]'), ["plain", "names"]);
assert.deepEqual(parseIconIndex("not json at all"), [], "a malformed index yields no names, not a crash");
assert.deepEqual(parseIconIndex('[{"hex":"fff"}]'), [], "an entry that names nothing is skipped");
assert.equal(estimatedBytes(["twemoji"]), 0, "per-icon packs hold nothing until an icon is used");
assert.equal(estimatedBytes([]), 0);

// --- untrusted SVG: an allowlist, not a blocklist ---------------------------

assert.ok(isAllowedSvgElement("path"));
assert.ok(isAllowedSvgElement("symbol"), "sprites reference their own symbols");
for (const hostile of ["script", "foreignObject", "iframe", "image", "animate", "set", "handler"]) {
	assert.equal(isAllowedSvgElement(hostile), false, `<${hostile}> is not carried over`);
}

assert.ok(isAllowedSvgAttribute("d", "M0 0h4v4H0z"));
assert.ok(isAllowedSvgAttribute("viewBox", "0 0 16 16"));
for (const handler of ["onload", "onclick", "onmouseover", "ONLOAD"]) {
	assert.equal(isAllowedSvgAttribute(handler, "alert(1)"), false, `${handler} is refused by name`);
}
assert.equal(isAllowedSvgAttribute("style", "background:url(x)"), false, "an icon never needs inline style");
assert.ok(isAllowedSvgAttribute("href", "#icon-name"), "a sprite may reference its own symbol");
for (const target of ["https://example.test/x.svg", "javascript:alert(1)", "//evil.test/x", "data:image/svg+xml,x"]) {
	assert.equal(isAllowedSvgAttribute("href", target), false, `href to ${target} is refused`);
	assert.equal(isAllowedSvgAttribute("xlink:href", target), false, `xlink:href to ${target} is refused`);
}
assert.equal(isAllowedSvgAttribute("unknown-attribute", "x"), false, "anything unrecognised is dropped");

assert.ok(looksLikeSvg('<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>'));
assert.equal(looksLikeSvg("<html><body>nope</body></html>"), false);
assert.equal(looksLikeSvg(""), false);

// --- pack icon ids stay distinguishable from built-in ones ------------------

assert.equal(packIconId("twemoji", "1f600"), "twemoji:1f600");
assert.deepEqual(splitPackIconId("twemoji:1f600"), { packId: "twemoji", icon: "1f600" });
assert.ok(isPackIconId("bootstrap-icons:alarm"));

// A Lucide id must never be mistaken for a pack id, or every built-in icon
// would stop resolving the moment a pack shipped with a colliding prefix.
for (const builtIn of ["alarm-clock", "file-code", "maximize-2", "chevrons-down-up"]) {
	assert.equal(isPackIconId(builtIn), false, `${builtIn} is a built-in id`);
	assert.equal(splitPackIconId(builtIn), null);
}
assert.equal(isPackIconId("unknown-pack:thing"), false, "an unknown prefix is not a pack");
assert.equal(splitPackIconId(":leading-colon"), null);
assert.equal(splitPackIconId("twemoji:"), null, "a namespace with no icon name resolves to nothing");
assert.equal(isIconPackEnabled("twemoji", new Set(["twemoji"])), true);
assert.equal(isIconPackEnabled("twemoji", ["iconoir"]), false, "a disabled known pack fails closed");
assert.equal(isIconPackEnabled("unknown-pack", ["unknown-pack"]), false, "enabled settings cannot create a pack");

// Packs without a name catalog expose one exact, syntactically safe candidate
// only when the user enabled that namespace. Artwork existence is validated by
// the runtime loader at selection time, not guessed by this pure query policy.
const enabledUncatalogued = new Set(["twemoji", "iconoir"]);
assert.equal(exactPackIconCandidate("twemoji:1f600", enabledUncatalogued), "twemoji:1f600");
assert.equal(exactPackIconCandidate("  iconoir:airplane  ", enabledUncatalogued), "iconoir:airplane");
for (const query of [
	"twemoji",
	"twemoji:",
	"twemoji:../../escape",
	"unknown-pack:thing",
	"simple-icons:github",
	"bootstrap-icons:alarm",
]) {
	assert.equal(exactPackIconCandidate(query, enabledUncatalogued), null, `does not offer ${JSON.stringify(query)}`);
}
assert.equal(
	exactPackIconCandidate("twemoji:1f600", new Set(["iconoir"])),
	null,
	"a known but disabled namespace fails closed",
);

console.log("icon-packs: ok");
