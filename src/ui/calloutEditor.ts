import { Notice, setIcon } from "obsidian";
import { calloutCatalog, type CalloutFold, type CalloutType } from "./calloutCatalog";
import { EditorLightbox } from "./lightbox";
import { buildCalloutTypeGrid } from "./toolbarView";
import type { RenderCtx } from "./blockShell";
import type { RegionTarget } from "./quickEdit";
import { buildCallout, parseCallout, type ParsedCallout } from "./calloutFence";

// Keep the established import surface while the pure parser/builder remains
// usable from Node tests without loading Obsidian UI modules.
export { buildCallout, parseCallout } from "./calloutFence";
export type { ParsedCallout } from "./calloutFence";

/**
 * The structured callout editor — an `EditorLightbox` derivative. Type, title,
 * and fold are header fields; the body edits WITHOUT its `> ` marks and the
 * live preview renders the ASSEMBLED callout. Re-quoting on save means a
 * callout typed inside the body nests one level automatically.
 */
export function openCalloutEditor(ctx: RenderCtx, target: RegionTarget): void {
	const parsed = parseCallout(target.original);
	if (!parsed) return;
	openCalloutEditorFor(ctx, parsed, (rebuilt) => {
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
		if (!accepted) new Notice("Mica: the callout changed while you were editing. Your edit is still open.");
		return accepted;
	});
}

/**
 * The editor itself, decoupled from WHERE the callout lives: `commit`
 * receives the reassembled callout text (nested callouts splice it back
 * into their parent region; top-level ones saveRegion directly).
 */
export function openCalloutEditorFor(
	ctx: RenderCtx,
	parsed: ParsedCallout,
	commit: (rebuilt: string) => boolean | void | Promise<boolean | void>,
): void {
	// Mutable field state shared by the header hook and the save/preview paths.
	const state = { type: parsed.type, fold: parsed.fold, title: parsed.title };
	const assemble = (body: string): string => buildCallout(parsed, { ...state, body });

	new EditorLightbox({
		app: ctx.app,
		title: "Edit callout",
		initial: parsed.body,
		sourcePath: ctx.sourcePath,
		previewTransform: assemble,
		isDirty: (body) =>
			body !== parsed.body ||
			state.type !== parsed.type ||
			state.fold !== parsed.fold ||
			state.title !== parsed.title,
		header: (host, refresh) => {
			const row = host.createDiv({ cls: "mica-coedit-row" });
			let closeTypePicker: (() => void) | null = null;

			// Type: current icon + name in the type's real (theme-driven) color;
			// clicking opens the same searchable grid the toolbar uses.
			const typeBtn = row.createEl("button", {
				cls: "clickable-icon mica-coedit-type",
				attr: { type: "button", "aria-label": "Change callout type" },
			});
			const paintType = (): void => {
				const t: CalloutType | undefined = calloutCatalog(ctx.app).find(
					(x) => x.id === state.type || x.aliases.includes(state.type),
				);
				typeBtn.empty();
				typeBtn.style.setProperty("--mica-co-color", t?.color ?? "var(--mica-accent)");
				setIcon(typeBtn.createSpan({ cls: "mica-callout-ico" }), t?.icon ?? "megaphone");
				typeBtn.createSpan({ cls: "mica-callout-name", text: state.type });
				setIcon(typeBtn.createSpan({ cls: "mica-coedit-caret" }), "chevron-down");
			};
			paintType();
			typeBtn.addEventListener("click", () => {
				closeTypePicker?.();
				typeBtn.setAttribute("aria-expanded", "true");
				const panel = row.createDiv({ cls: "mica-popover mica-coedit-typepop" }) as HTMLElement & {
					micaClose?: () => void;
				};
				let closed = false;
				function closeOwned(): void {
					close();
				}
				const close = (restoreFocus = false): void => {
					if (closed) return;
					closed = true;
					panel.remove();
					document.removeEventListener("pointerdown", onOut, true);
					document.removeEventListener("keydown", onKey, true);
					if (closeTypePicker === closeOwned) closeTypePicker = null;
					typeBtn.setAttribute("aria-expanded", "false");
					if (restoreFocus && typeBtn.isConnected) typeBtn.focus();
				};
				closeTypePicker = closeOwned;
				panel.micaClose = () => close();
				const onOut = (ev: PointerEvent): void => {
					if (!panel.contains(ev.target as Node)) close();
				};
				const onKey = (event: KeyboardEvent): void => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					close(true);
				};
				document.addEventListener("pointerdown", onOut, true);
				document.addEventListener("keydown", onKey, true);
				buildCalloutTypeGrid(panel, ctx.app, (t) => {
					state.type = t.id;
					paintType();
					refresh();
					close();
				});
			});

			const foldBtns: HTMLButtonElement[] = [];
			const foldOpt = (label: string, value: CalloutFold, tip: string): void => {
				const b = row.createEl("button", {
					cls: `clickable-icon mica-pop-seg ${value === state.fold ? "is-on" : ""}`,
					text: label,
					attr: { type: "button", "aria-label": tip },
				});
				b.addEventListener("click", () => {
					state.fold = value;
					foldBtns.forEach((x) => x.removeClass("is-on"));
					b.addClass("is-on");
					refresh();
				});
				foldBtns.push(b);
			};
			foldOpt("Static", "", "Always expanded");
			foldOpt("Open", "+", "Foldable, starts open");
			foldOpt("Collapsed", "-", "Foldable, starts collapsed");

			const titleInput = row.createEl("input", {
				cls: "mica-coedit-title",
				attr: { type: "text", placeholder: "Title (optional)" },
			});
			titleInput.value = state.title;
			titleInput.addEventListener("input", () => {
				state.title = titleInput.value.trim();
				refresh();
			});
			return () => closeTypePicker?.();
		},
		onSave: (body) => commit(assemble(body)),
	}).open();
}
