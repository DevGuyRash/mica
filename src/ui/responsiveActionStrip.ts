import { setIcon, type App } from "obsidian";
import { mountActionMenu, type ActionSpec } from "./actionMenu";
import { packResponsiveActions, type ResponsiveActionCandidate } from "./responsiveActions";

export interface ResponsiveActionStripOptions {
	app: App;
	source: HTMLElement;
	label: string;
	className?: string;
	buttonClass?: string;
	menuClass?: string;
	menuOnly?: boolean;
	preserveFocus?: boolean;
	reservedWidth?: () => number;
}

export interface MountedResponsiveActionStrip {
	element: HTMLElement;
	refresh: () => void;
	isOpen: () => boolean;
	close: () => void;
	destroy: () => void;
}

type WidthSubscriber = () => void;

const widthSubscribers = new Map<Element, Set<WidthSubscriber>>();
const mountedLayouts = new Set<WidthSubscriber>();
let sharedObserver: ResizeObserver | null = null;

function observer(): ResizeObserver {
	sharedObserver ??= new ResizeObserver((entries) => {
		for (const entry of entries) for (const subscriber of widthSubscribers.get(entry.target) ?? []) subscriber();
	});
	return sharedObserver;
}

function observeWidth(target: Element, subscriber: WidthSubscriber): () => void {
	let subscribers = widthSubscribers.get(target);
	if (!subscribers) {
		subscribers = new Set();
		widthSubscribers.set(target, subscribers);
		observer().observe(target);
	}
	subscribers.add(subscriber);
	return () => {
		const current = widthSubscribers.get(target);
		current?.delete(subscriber);
		if (current?.size) return;
		widthSubscribers.delete(target);
		sharedObserver?.unobserve(target);
		if (widthSubscribers.size) return;
		sharedObserver?.disconnect();
		sharedObserver = null;
	};
}

/** Re-measure every mounted strip after density/theme/tool configuration changes. */
export function invalidateResponsiveActionStrips(): void {
	for (const layout of mountedLayouts) layout();
}

/** One width-aware action strip. Packing is O(local actions), and the shared
 * observer is the only resize observer allocated regardless of entity count. */
export function mountResponsiveActionStrip(
	parent: HTMLElement,
	getActions: () => readonly ActionSpec[],
	options: ResponsiveActionStripOptions,
): MountedResponsiveActionStrip {
	const root = parent.createDiv({ cls: `mica-responsive-actions ${options.className ?? ""}`.trim() });
	const directButtons = new Map<string, HTMLButtonElement>();
	let overflowIds = new Set<string>();
	let frame: number | null = null;
	let destroyed = false;
	let forceMeasure = true;
	let attachmentRetries = 0;
	let settlePasses = 2;

	const menu = mountActionMenu(
		root,
		() => getActions().filter((action) => overflowIds.has(action.id)),
		`${options.menuClass ?? options.buttonClass ?? "mica-responsive-action"} mica-responsive-more`,
		options.label,
		options.app,
	);
	menu.button.dataset.micaResponsiveRole = "overflow";
	menu.button.style.display = "none";
	const initialActionIds = getActions()
		.map((action) => action.id)
		.join(" ");
	root.dataset.micaActionStrip = initialActionIds;
	menu.button.dataset.micaActions = initialActionIds;
	menu.button.dataset.micaOverflowActions = initialActionIds;

	const ensureButton = (action: ActionSpec): HTMLButtonElement => {
		let button = directButtons.get(action.id);
		if (button) return button;
		button = root.createEl("button", {
			cls: `clickable-icon mica-responsive-action ${options.buttonClass ?? ""}`.trim(),
			attr: { type: "button", "aria-label": action.label, "data-mica-action": action.id },
		});
		root.insertBefore(button, menu.button);
		if (action.icon) setIcon(button, action.icon);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		if (options.preserveFocus) button.addEventListener("mousedown", (event) => event.preventDefault());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			getActions()
				.find((current) => current.id === action.id && !current.disabled)
				?.run();
		});
		directButtons.set(action.id, button);
		return button;
	};

	const paintState = (button: HTMLButtonElement, action: ActionSpec): void => {
		button.setAttribute("aria-label", action.label);
		button.disabled = Boolean(action.disabled);
		button.toggleClass("is-disabled", Boolean(action.disabled));
		button.toggleClass("is-danger", Boolean(action.danger));
		if (action.checked === undefined) button.removeAttribute("aria-pressed");
		else {
			button.setAttribute("aria-pressed", String(action.checked));
			button.toggleClass("is-on", action.checked);
		}
	};

	// Establish an immediately usable optimistic layout before the widget is
	// attached. Wide strips start with their direct actions and no ellipsis;
	// menu-only strips start with only their menu. The measured pass can then
	// move actions without a transient missing-controls state.
	const initialActions = [...getActions()];
	overflowIds = new Set(
		options.menuOnly
			? initialActions.map((action) => action.id)
			: initialActions.filter((action) => action.overflowOnly).map((action) => action.id),
	);
	for (const action of initialActions) {
		if (action.overflowOnly || (action.directPriority === undefined && !action.pinned)) continue;
		const button = ensureButton(action);
		paintState(button, action);
		button.style.display = options.menuOnly ? "none" : "inline-flex";
	}
	menu.button.style.display = overflowIds.size ? "inline-flex" : "none";
	menu.button.dataset.micaOverflowActions = [...overflowIds].join(" ");

	const performLayout = (): void => {
		frame = null;
		if (destroyed) return;
		// Widgets are commonly assembled in a detached CodeMirror tree. A first
		// measurement there is zero and used to remain stale until an unrelated
		// resize woke the observer. Retry only across the short attachment window;
		// the observer owns later hidden/visible transitions without a polling loop.
		if ((!root.isConnected || options.source.clientWidth <= 0) && attachmentRetries < 12) {
			attachmentRetries++;
			forceMeasure = true;
			frame = window.requestAnimationFrame(performLayout);
			return;
		}
		attachmentRetries = 0;
		const actions = [...getActions()];
		const liveIds = new Set(actions.map((action) => action.id));
		for (const [id, button] of directButtons) {
			if (liveIds.has(id)) continue;
			button.remove();
			directButtons.delete(id);
		}
		for (const action of actions) {
			if (action.overflowOnly || (action.directPriority === undefined && !action.pinned)) continue;
			paintState(ensureButton(action), action);
		}

		const gap = Number.parseFloat(getComputedStyle(root).gap) || 0;
		if (forceMeasure) {
			root.addClass("is-measuring");
			for (const button of directButtons.values()) button.style.display = "inline-flex";
			menu.button.style.display = "inline-flex";
		}
		const menuWidth = menu.button.getBoundingClientRect().width || menu.button.offsetWidth || 30;
		const candidates: ResponsiveActionCandidate[] = actions.map((action) => ({
			id: action.id,
			width:
				directButtons.get(action.id)?.getBoundingClientRect().width ||
				directButtons.get(action.id)?.offsetWidth ||
				menuWidth,
			directPriority: action.directPriority,
			overflowOnly: action.overflowOnly,
			pinned: action.pinned,
		}));
		const available = Math.max(0, options.source.clientWidth - (options.reservedWidth?.() ?? 0));
		const packing = packResponsiveActions(candidates, available, gap, menuWidth, options.menuOnly);
		const directIds = new Set(packing.direct);
		overflowIds = new Set(packing.overflow);
		for (const [id, button] of directButtons) button.style.display = directIds.has(id) ? "inline-flex" : "none";
		menu.button.style.display = overflowIds.size ? "inline-flex" : "none";
		root.dataset.micaActionStrip = actions.map((action) => action.id).join(" ");
		// Keep the semantic action inventory discoverable for integrations and
		// tests; mountActionMenu still receives overflowIds only, so advertised
		// capability never duplicates a direct command in the opened menu.
		menu.button.dataset.micaActions = root.dataset.micaActionStrip;
		menu.button.dataset.micaOverflowActions = packing.overflow.join(" ");
		root.toggleClass("has-overflow", overflowIds.size > 0);
		root.removeClass("is-measuring");
		forceMeasure = false;
		// A second connected pass catches fonts/theme rules that settle after the
		// widget was mounted without waiting for user interaction.
		if (settlePasses > 0) {
			settlePasses--;
			forceMeasure = true;
			frame = window.requestAnimationFrame(performLayout);
		}
	};

	const scheduleLayout = (): void => {
		if (destroyed || frame !== null) return;
		frame = window.requestAnimationFrame(performLayout);
	};
	const refresh = (): void => {
		forceMeasure = true;
		scheduleLayout();
	};
	const stopObserving = observeWidth(options.source, scheduleLayout);
	mountedLayouts.add(refresh);
	refresh();

	return {
		element: root,
		refresh,
		isOpen: menu.isOpen,
		close: menu.close,
		destroy: () => {
			if (destroyed) return;
			destroyed = true;
			if (frame !== null) window.cancelAnimationFrame(frame);
			mountedLayouts.delete(refresh);
			stopObserving();
			menu.destroy();
			root.remove();
		},
	};
}
