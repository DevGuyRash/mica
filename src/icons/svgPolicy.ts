/**
 * What is allowed to survive from a fetched icon.
 *
 * An SVG downloaded from a CDN is untrusted input at a boundary: it can carry
 * `<script>`, event handlers, or `javascript:` targets, and inserting it with
 * `innerHTML` would execute them inside the vault. The policy is an allowlist —
 * anything unrecognised is dropped rather than inspected — and it is kept pure
 * so the rules can be tested without a DOM.
 */

/** Presentation and geometry only: no scripting, no embedding, no external refs. */
const ALLOWED_ELEMENTS = new Set([
	"svg",
	"g",
	"path",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"rect",
	"defs",
	"symbol",
	"use",
	"title",
	"desc",
	"linearGradient",
	"radialGradient",
	"stop",
	"clipPath",
	"mask",
]);

const ALLOWED_ATTRIBUTES = new Set([
	"d",
	"fill",
	"fill-rule",
	"fill-opacity",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-opacity",
	"opacity",
	"transform",
	"viewBox",
	"width",
	"height",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"points",
	"offset",
	"stop-color",
	"stop-opacity",
	"gradientUnits",
	"gradientTransform",
	"clip-path",
	"clip-rule",
	"mask",
	"id",
	"xmlns",
]);

export function isAllowedSvgElement(name: string): boolean {
	return ALLOWED_ELEMENTS.has(name);
}

/**
 * Whether one attribute may be kept.
 *
 * `href` is the only attribute whose *value* decides: `<use href="#id">` is how
 * a sprite references its own symbols, while any other target reaches outside
 * the document. Event handlers are refused by name, and `style` is refused
 * outright — it can carry `url()` references and is never needed by an icon.
 */
export function isAllowedSvgAttribute(name: string, value: string): boolean {
	const attribute = name.toLowerCase();
	if (attribute.startsWith("on")) return false;
	if (attribute === "style") return false;
	if (attribute === "href" || attribute === "xlink:href") return value.startsWith("#");
	return ALLOWED_ATTRIBUTES.has(name) || ALLOWED_ATTRIBUTES.has(attribute);
}

/** A quick pre-check so obviously hostile payloads never reach the parser. */
export function looksLikeSvg(markup: string): boolean {
	const head = markup.slice(0, 4096).toLowerCase();
	return head.includes("<svg");
}
