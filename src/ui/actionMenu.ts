import { Menu, Scope, setIcon, type App } from "obsidian";
import type { DirectActionPriority } from "./responsiveActions";

export type ActionMenuTrigger = "click" | "hover";

export interface ActionSpec {
	id: string;
	label: string;
	icon?: string;
	checked?: boolean;
	disabled?: boolean;
	danger?: boolean;
	separatorBefore?: boolean;
	/** Lower values remain direct longer as a responsive strip shrinks. */
	directPriority?: DirectActionPriority;
	/** Keep this action in the ellipsis even when space is available. */
	overflowOnly?: boolean;
	/** Never collapse this action into the ellipsis. */
	pinned?: boolean;
	/** Nested actions, shown as a second menu. Built from a plain `Menu` rather
	 * than `MenuItem.setSubmenu`, which the supported API does not declare — and
	 * the minimum-version E2E profile would be the one to discover that. */
	children?: readonly ActionSpec[];
	run: () => void;
}

let triggerMode: ActionMenuTrigger = "click";

export function setActionMenuTrigger(mode: ActionMenuTrigger): void {
	triggerMode = mode;
}

export function populateActionMenu(menu: Menu, actions: readonly ActionSpec[]): void {
	let first = true;
	for (const action of actions) {
		if (!first && action.separatorBefore) menu.addSeparator();
		first = false;
		menu.addItem((item) => {
			item.setTitle(action.label);
			if (action.icon) item.setIcon(action.icon);
			if (action.checked !== undefined) item.setChecked(action.checked);
			if (action.disabled) item.setDisabled(true);
			if (action.danger) item.setWarning(true);
			const children = action.children;
			if (children?.length) item.onClick((event) => openChildMenu(children, event));
			else item.onClick(() => action.run());
		});
	}
}

/** Second-level menu, anchored at whatever opened it. The parent menu has
 * already dismissed itself by the time this runs, so the child owns the screen
 * and Obsidian's outside-click dismissal applies to it normally. */
function openChildMenu(children: readonly ActionSpec[], event: MouseEvent | KeyboardEvent): Menu {
	if (event instanceof MouseEvent && event.detail > 0) {
		const child = new Menu();
		populateActionMenu(child, children);
		child.showAtMouseEvent(event);
		return child;
	}
	return openActionMenuAt(children, event.target as HTMLElement | null);
}

/** Open a menu beside an element. Keyboard activations have no useful pointer
 * coordinate, and a direct strip button has no pointer position worth reusing
 * either — both want the menu anchored to the control that opened it. */
export function openActionMenuAt(actions: readonly ActionSpec[], anchor: HTMLElement | null): Menu {
	const menu = new Menu();
	populateActionMenu(menu, actions);
	const rect = anchor?.getBoundingClientRect();
	menu.showAtPosition(rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 });
	return menu;
}

export function showActionMenuAtEvent(event: MouseEvent, actions: readonly ActionSpec[]): Menu {
	const menu = new Menu();
	populateActionMenu(menu, actions);
	menu.showAtMouseEvent(event);
	return menu;
}

/** Mount one accessible entity-actions trigger. Hover is additive: keyboard and
 * click remain available, while touch/coarse pointers always stay click-only. */
export function mountActionMenu(
	parent: HTMLElement,
	getActions: () => readonly ActionSpec[],
	className = "mica-action-trigger",
	label = "More actions",
	app?: App,
): { button: HTMLButtonElement; isOpen: () => boolean; close: () => void; destroy: () => void } {
	const button = parent.createEl("button", {
		cls: `clickable-icon ${className}`,
		attr: {
			type: "button",
			"aria-label": label,
			"aria-haspopup": "menu",
			"aria-expanded": "false",
		},
	});
	setIcon(button, "ellipsis-vertical");
	let openTimer = 0;
	let leaveTimer = 0;
	let menu: Menu | null = null;
	let menuKeyOwner = false;
	let releaseKeyTimer = 0;
	const menuScope = app ? new Scope() : null;
	menuScope?.register([], "Escape", (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		const current = menu;
		current?.hide();
		closeState(current ?? undefined);
		button.focus();
		return false;
	});
	const onMenuKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || !menuKeyOwner) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const current = menu;
		current?.hide();
		closeState(current ?? undefined);
		button.focus();
	};
	const releaseMenuKeys = (): void => {
		if (!menuKeyOwner) return;
		menuKeyOwner = false;
		if (app && menuScope) app.keymap.popScope(menuScope);
		window.removeEventListener("keydown", onMenuKeydown, true);
	};

	const closeState = (expected?: Menu): void => {
		// A native mobile menu can finish its asynchronous onHide after a new
		// menu has already opened from the same trigger. That stale callback must
		// never clear or release the newer menu's state.
		if (expected && menu && menu !== expected) return;
		menu = null;
		button.setAttribute("aria-expanded", "false");
		button.removeClass("is-active");
		// Obsidian's native menu removes its own keymap scope during the Escape
		// event. Keep Mica's owner scope through the rest of that dispatch so the
		// same key cannot fall through and close the parent editor/modal.
		window.clearTimeout(releaseKeyTimer);
		releaseKeyTimer = window.setTimeout(releaseMenuKeys, 0);
	};
	const open = (event?: MouseEvent): void => {
		window.clearTimeout(openTimer);
		window.clearTimeout(leaveTimer);
		window.clearTimeout(releaseKeyTimer);
		if (menu) return;
		const actions = getActions();
		if (!actions.length) return;
		const current = new Menu();
		menu = current;
		populateActionMenu(current, actions);
		current.onHide(() => closeState(current));
		menuKeyOwner = true;
		if (app && menuScope) app.keymap.pushScope(menuScope);
		// Window capture runs before Obsidian's mobile menu/keymap handlers, which
		// may otherwise consume Escape before it reaches the document.
		window.addEventListener("keydown", onMenuKeydown, true);
		button.setAttribute("aria-expanded", "true");
		button.addClass("is-active");
		if (event) current.showAtMouseEvent(event);
		else {
			const rect = button.getBoundingClientRect();
			current.showAtPosition({ x: rect.right, y: rect.bottom });
		}
	};
	const onClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		// Keyboard-generated button clicks have no useful pointer coordinate.
		// Anchor those beside the trigger instead of at the viewport origin.
		open(event.detail > 0 ? event : undefined);
	};
	const onPointerEnter = (): void => {
		if (triggerMode !== "hover" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
		window.clearTimeout(openTimer);
		window.clearTimeout(leaveTimer);
		openTimer = window.setTimeout(() => open(), 260);
	};
	const onPointerLeave = (): void => {
		// Forgive a brief imprecise pointer path without making hover-open sticky.
		// Once the native menu is visible, it owns dismissal and focus behavior.
		leaveTimer = window.setTimeout(() => window.clearTimeout(openTimer), 120);
	};
	button.addEventListener("click", onClick);
	button.addEventListener("pointerenter", onPointerEnter);
	button.addEventListener("pointerleave", onPointerLeave);

	return {
		button,
		isOpen: () => menu !== null,
		close: () => {
			const current = menu;
			current?.hide();
			closeState(current ?? undefined);
			button.focus();
		},
		destroy: () => {
			window.clearTimeout(openTimer);
			window.clearTimeout(leaveTimer);
			window.clearTimeout(releaseKeyTimer);
			releaseMenuKeys();
			menu?.hide();
			button.removeEventListener("click", onClick);
			button.removeEventListener("pointerenter", onPointerEnter);
			button.removeEventListener("pointerleave", onPointerLeave);
		},
	};
}
