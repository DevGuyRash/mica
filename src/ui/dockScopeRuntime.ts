import { applyOpText, type StructOp } from "../cst/ops";
import { parseBlock, type Cst } from "../wasm/bridge";
import { buildScopeIndexFromCst, type ScopeIndex } from "./versionScopeCore";
import type { DockDraftOverlay, DockTargetController } from "./dockScope";

export interface DockRuntimeSource {
	source: string;
	cst: Cst;
	index: ScopeIndex;
}

/** Runtime adapter: structural parsing remains in the Rust core, while the
 * selection/controller module stays directly testable in Node. */
export function buildDockRuntimeSource(source: string): DockRuntimeSource {
	const cst = parseBlock(source);
	return { source, cst, index: buildScopeIndexFromCst(source, cst) };
}

export function sourceWithDraft(source: string, draft?: DockDraftOverlay | null): string {
	if (!draft || draft.text === draft.expected) return source;
	const op: StructOp = {
		op: "saveRegion",
		path: [...draft.path],
		start: draft.start,
		end: draft.end,
		expected: draft.expected,
		text: draft.text,
	};
	const applied = applyOpText(source, op);
	return applied.changed ? applied.text : source;
}

export function resolveDockTarget(
	controller: DockTargetController,
	source: string,
): (DockRuntimeSource & { scope: ReturnType<DockTargetController["current"]>["scope"] }) | null {
	const runtime = buildDockRuntimeSource(source);
	const resolved = controller.resolveIn(runtime.index);
	return resolved ? { ...runtime, scope: resolved.scope } : null;
}
