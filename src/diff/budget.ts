/** Interactive diffing runs synchronously in WebAssembly on Obsidian's UI
 * thread. These limits keep adversarial or accidentally huge histories from
 * freezing the app; the CLI remains available for larger comparisons. */
export const MAX_INTERACTIVE_DIFF_CODE_UNITS = 512 * 1024;
export const MAX_INTERACTIVE_DIFF_LINES = 5_000;
export const MAX_INTERACTIVE_DIFF_LINE_CODE_UNITS = 32 * 1024;
export const MAX_INTERACTIVE_CHAR_DIFF_CODE_UNITS = 64 * 1024;
export const MAX_INTERACTIVE_WORD_DIFF_CODE_UNITS = 128 * 1024;

export type InteractiveDiffGranularity = "line" | "line-word" | "line-char" | "word" | "char";

/** Return a user-facing reason when a synchronous interactive diff would be
 * too expensive. A null result means the inputs fit every work budget. */
export function interactiveDiffIssue(
	base: string,
	other: string,
	granularity: InteractiveDiffGranularity,
): string | null {
	const total = base.length + other.length;
	if (granularity === "char" && total > MAX_INTERACTIVE_CHAR_DIFF_CODE_UNITS) {
		return `character diff exceeds the ${formatLimit(MAX_INTERACTIVE_CHAR_DIFF_CODE_UNITS)} interactive limit`;
	}
	if (granularity === "word" && total > MAX_INTERACTIVE_WORD_DIFF_CODE_UNITS) {
		return `word diff exceeds the ${formatLimit(MAX_INTERACTIVE_WORD_DIFF_CODE_UNITS)} interactive limit`;
	}
	if (total > MAX_INTERACTIVE_DIFF_CODE_UNITS) {
		return `comparison exceeds the ${formatLimit(MAX_INTERACTIVE_DIFF_CODE_UNITS)} interactive limit`;
	}
	const baseIssue = textShapeIssue(base);
	if (baseIssue) return baseIssue;
	return textShapeIssue(other);
}

function textShapeIssue(text: string): string | null {
	let lines = 1;
	let lineStart = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) !== 10) continue;
		if (index - lineStart > MAX_INTERACTIVE_DIFF_LINE_CODE_UNITS) {
			return `a line exceeds the ${formatLimit(MAX_INTERACTIVE_DIFF_LINE_CODE_UNITS)} interactive limit`;
		}
		lines += 1;
		if (lines > MAX_INTERACTIVE_DIFF_LINES) {
			return `comparison exceeds the ${MAX_INTERACTIVE_DIFF_LINES.toLocaleString()}-line interactive limit`;
		}
		lineStart = index + 1;
	}
	if (text.length - lineStart > MAX_INTERACTIVE_DIFF_LINE_CODE_UNITS) {
		return `a line exceeds the ${formatLimit(MAX_INTERACTIVE_DIFF_LINE_CODE_UNITS)} interactive limit`;
	}
	return null;
}

function formatLimit(codeUnits: number): string {
	return `${Math.floor(codeUnits / 1024)} KiB`;
}
