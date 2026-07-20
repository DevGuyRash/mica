import { buildCodeFence, parseCodeFence } from "./codeFence";
import { parseCallout } from "./calloutFence";

export type SectionKind = "markdown" | "callout" | "code";
export type SectionConversionWarningName = "callout-metadata-loss" | "code-info-loss";

export interface SectionConversionWarning {
	name: SectionConversionWarningName;
	message: string;
	metadata: Readonly<Record<string, string>>;
}

export interface SectionConversion {
	from: SectionKind;
	to: SectionKind;
	text: string;
	warnings: SectionConversionWarning[];
}

/** Derive a section's semantic format from its standard Markdown source. */
export function classifySection(source: string): SectionKind {
	if (parseCallout(source)) return "callout";
	if (parseCodeFence(source)) return "code";
	return "markdown";
}

/**
 * Convert standard Markdown representations without introducing Mica syntax.
 * Render/source are interaction views and therefore never enter this model.
 */
export function convertSection(source: string, target: SectionKind): SectionConversion {
	const from = classifySection(source);
	if (from === target) return { from, to: target, text: source, warnings: [] };

	const unwrapped = unwrapSection(source, from);
	const text =
		target === "markdown"
			? unwrapped.text
			: target === "callout"
				? wrapCallout(unwrapped.text)
				: wrapCode(unwrapped.text);
	return { from, to: target, text, warnings: unwrapped.warnings };
}

function unwrapSection(source: string, kind: SectionKind): { text: string; warnings: SectionConversionWarning[] } {
	if (kind === "markdown") return { text: source, warnings: [] };
	if (kind === "callout") {
		const parsed = parseCallout(source);
		if (!parsed) return { text: source, warnings: [] };
		return {
			text: parsed.prefix + parsed.bodySource + parsed.suffix,
			warnings: [
				{
					name: "callout-metadata-loss",
					message: "Converting removes the callout type, fold state, and title.",
					metadata: { type: parsed.type, fold: parsed.fold, title: parsed.title },
				},
			],
		};
	}

	const parsed = parseCodeFence(source);
	if (!parsed) return { text: source, warnings: [] };
	const structuralEol = endingEol(parsed.body);
	const body = structuralEol ? parsed.body.slice(0, -structuralEol.length) : parsed.body;
	const info = parsed.infoRaw.trim();
	return {
		text: parsed.prefix + body + parsed.closeEol + parsed.suffix,
		warnings: info
			? [
					{
						name: "code-info-loss",
						message: "Converting removes the fenced-code info string.",
						metadata: { info },
					},
				]
			: [],
	};
}

/** Wrap exact prose as a default Obsidian callout, retaining every body EOL. */
function wrapCallout(source: string): string {
	const eol = firstEol(source) ?? "\n";
	let body = "";
	for (const line of sourceLines(source)) {
		body += `>${line.content ? ` ${line.content}` : ""}${line.eol}`;
	}
	return `> [!note]${eol}${body}`;
}

/**
 * Wrap exact prose in a closed code fence. A dedicated structural EOL before
 * the closer plus the closer's own EOL preserve no-final-newline and mixed-EOL
 * prose when the conversion is reversed.
 */
function wrapCode(source: string): string {
	const openEol = firstEol(source) ?? "\n";
	const closeEol = endingEol(source);
	const body = source.slice(0, source.length - closeEol.length) + openEol;
	const baseline = `\`\`\`${openEol}\`\`\`${closeEol}`;
	const parsed = parseCodeFence(baseline);
	if (!parsed) throw new Error("internal fenced-code factory produced invalid Markdown");
	return buildCodeFence(parsed, { body });
}

function firstEol(source: string): "\n" | "\r\n" | null {
	const newline = source.indexOf("\n");
	if (newline < 0) return null;
	return newline > 0 && source[newline - 1] === "\r" ? "\r\n" : "\n";
}

function endingEol(source: string): "" | "\n" | "\r\n" {
	if (source.endsWith("\r\n")) return "\r\n";
	return source.endsWith("\n") ? "\n" : "";
}

function sourceLines(source: string): Array<{ content: string; eol: "" | "\n" | "\r\n" }> {
	const lines: Array<{ content: string; eol: "" | "\n" | "\r\n" }> = [];
	let start = 0;
	while (start < source.length) {
		const newline = source.indexOf("\n", start);
		if (newline < 0) {
			lines.push({ content: source.slice(start), eol: "" });
			break;
		}
		const crlf = newline > start && source[newline - 1] === "\r";
		lines.push({
			content: source.slice(start, crlf ? newline - 1 : newline),
			eol: crlf ? "\r\n" : "\n",
		});
		start = newline + 1;
	}
	return lines;
}
