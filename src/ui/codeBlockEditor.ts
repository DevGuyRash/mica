import { Notice } from "obsidian";
import { buildCodeFence, parseCodeFence, type ParsedCodeFence } from "./codeFence";
import { EditorLightbox } from "./lightbox";
import type { RenderCtx } from "./blockShell";
import type { RegionTarget } from "./quickEdit";
import { resolveCodeLanguage } from "./codeLangs";

/** Open the structured editor for a top-level fenced-code region. */
export function openCodeBlockEditor(ctx: RenderCtx, target: RegionTarget): void {
	const parsed = parseCodeFence(target.original);
	if (!parsed) return;
	openCodeBlockEditorFor(ctx, parsed, (rebuilt) => {
		if (rebuilt === target.original) return true;
		const accepted =
			ctx.editable?.apply({
				op: "saveRegion",
				path: target.path,
				start: target.start,
				end: target.end,
				expected: target.original,
				text: rebuilt,
			}) ?? false;
		if (!accepted) new Notice("Mica: the code block changed while you were editing. Your edit is still open.");
		return accepted;
	});
}

/**
 * The code editor itself, decoupled from where the fence lives. Nested callers
 * can splice the rebuilt, safely-sized fence back into a parent callout while
 * top-level callers use the guarded region reducer above.
 */
export function openCodeBlockEditorFor(
	ctx: RenderCtx,
	parsed: ParsedCodeFence,
	commit: (rebuilt: string) => boolean | void | Promise<boolean | void>,
): void {
	const state = { infoRaw: parsed.infoRaw };
	const assemble = (body: string): string => buildCodeFence(parsed, { infoRaw: state.infoRaw, body });

	new EditorLightbox({
		app: ctx.app,
		title: "Edit code block",
		initial: parsed.body,
		sourcePath: ctx.sourcePath,
		editorLanguage: { kind: "code", info: parsed.infoRaw },
		editorLineSeparator: parsed.openEol,
		previewTransform: assemble,
		isDirty: (body) => body !== parsed.body || state.infoRaw !== parsed.infoRaw,
		header: (host, refresh, setEditorLanguage) => {
			const row = host.createDiv({ cls: "mica-coedit-row" });
			row.createSpan({ cls: "mica-coedit-label", text: "Language / info" });
			const input = row.createEl("input", {
				cls: "mica-coedit-title mica-codeedit-info",
				attr: {
					type: "text",
					placeholder: "Language ID: markdown, md, javascript",
					"aria-label": "Language / info (optional)",
					spellcheck: "false",
				},
			});
			input.value = state.infoRaw;
			const status = row.createSpan({ cls: "mica-codeedit-status" });
			const paintStatus = (): void => {
				const token = state.infoRaw.trimStart().match(/^[^\s]+/)?.[0] ?? "";
				const language = token ? resolveCodeLanguage(token) : null;
				status.setText(language?.name ?? "Plain text");
				status.toggleClass("is-plain", !language);
			};
			paintStatus();
			let warnedAboutBackticks = false;
			input.addEventListener("input", () => {
				const safe = parsed.fenceChar === "`" ? input.value.replaceAll("`", "") : input.value;
				if (safe !== input.value) {
					input.value = safe;
					if (!warnedAboutBackticks) {
						warnedAboutBackticks = true;
						new Notice("Mica: backticks are not valid in a backtick fence's info string.");
					}
				}
				state.infoRaw = safe;
				setEditorLanguage({ kind: "code", info: state.infoRaw });
				paintStatus();
				refresh();
			});
		},
		onSave: (body) => commit(assemble(body)),
	}).open();
}
