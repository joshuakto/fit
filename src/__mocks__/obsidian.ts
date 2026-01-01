import { vi } from 'vitest';

export const arrayBufferToBase64 = vi.fn((buffer: ArrayBuffer) => {
	// Mock of Obsidian's native arrayBufferToBase64 function.
	// Real implementation is in C++ and highly optimized.
	// This mock processes in chunks for reasonable test performance while avoiding
	// the "Maximum call stack size exceeded" issue from PR #127.
	const bytes = new Uint8Array(buffer);
	const CHUNK_SIZE = 0x8000; // 32KB chunks - small enough to avoid stack overflow
	const chunks = [];
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
		// String.fromCharCode.apply() is much faster than char-by-char concatenation.
		// Uses apply with small chunks to avoid the original PR #127 issue.
		chunks.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
	}
	return btoa(chunks.join(''));
});

export const base64ToArrayBuffer = vi.fn((base64: string) => {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
});

export class TFile {
	path!: string;
	name!: string;
	extension!: string;
	basename!: string;
}

export class TFolder {
	path!: string;
	children: any[] = [];
}

export class Vault {
	readBinary = vi.fn();
	cachedRead = vi.fn();
}

export class Component {
	load = vi.fn();
	unload = vi.fn();
}

export class Notice {
	constructor(message: string) {}
	setMessage = vi.fn();
	hide = vi.fn();
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
};

// ========================================================
// SETTINGS APIS
// ========================================================

/**
 * Enhances an HTMLElement with Obsidian-like helper methods.
 * These methods mirror the Obsidian API for creating and manipulating elements.
 */
function enhanceElement<T extends HTMLElement>(el: T): T {
	// Use 'any' to avoid complex type gymnastics for mock - this is test infrastructure
	const enhanced = el as any;

	enhanced.createEl = (tag: string, opts?: { cls?: string; attr?: Record<string, string>; text?: string }) => {
		const child = document.createElement(tag);
		if (opts?.cls) child.className = opts.cls;
		if (opts?.attr) Object.entries(opts.attr).forEach(([k, v]) => child.setAttribute(k, v));
		if (opts?.text) child.textContent = opts.text;
		el.appendChild(child);
		return enhanceElement(child);
	};

	enhanced.createDiv = (opts?: { cls?: string; attr?: Record<string, string>; text?: string }) => {
		return enhanced.createEl('div', opts);
	};

	enhanced.empty = () => { el.innerHTML = ''; return enhanced; };
	enhanced.addClass = (cls: string) => { el.classList.add(cls); return enhanced; };
	enhanced.removeClass = (cls: string) => { el.classList.remove(cls); return enhanced; };
	enhanced.toggleClass = (cls: string, value: boolean) => { el.classList.toggle(cls, value); return enhanced; };
	enhanced.setText = (text: string) => { el.textContent = text; return enhanced; };

	return enhanced;
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: HTMLElement;

	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = enhanceElement(document.createElement('div'));
	}

	display() {}
	hide() {}
}

/**
 * Minimal ButtonComponent that wraps a real button element.
 * Enables behavior-driven testing via actual DOM events.
 */
export class ButtonComponent {
	buttonEl: HTMLButtonElement;

	constructor(containerEl: HTMLElement) {
		this.buttonEl = document.createElement('button');
		containerEl.appendChild(this.buttonEl);
	}

	setButtonText(text: string) { this.buttonEl.textContent = text; return this; }
	setCta() { this.buttonEl.classList.add('mod-cta'); return this; }
	setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
	onClick(cb: () => void) { this.buttonEl.addEventListener('click', cb); return this; }
	setIcon(_icon: string) { return this; }
	setTooltip(_tooltip: string) { return this; }
}

/**
 * Minimal TextComponent that wraps a real input element.
 * Enables testing by typing into actual inputs.
 */
export class TextComponent {
	inputEl: HTMLInputElement;

	constructor(containerEl: HTMLElement) {
		this.inputEl = document.createElement('input');
		this.inputEl.type = 'text';
		containerEl.appendChild(this.inputEl);
	}

	setValue(value: string) { this.inputEl.value = value; return this; }
	setPlaceholder(ph: string) { this.inputEl.placeholder = ph; return this; }
	onChange(cb: (value: string) => void) {
		this.inputEl.addEventListener('input', () => cb(this.inputEl.value));
		return this;
	}
}

/**
 * Minimal DropdownComponent that wraps a real select element.
 */
export class DropdownComponent {
	selectEl: HTMLSelectElement;

	constructor(containerEl: HTMLElement) {
		this.selectEl = enhanceElement(document.createElement('select'));
		containerEl.appendChild(this.selectEl);
	}

	addOption(value: string, label: string) {
		const opt = document.createElement('option');
		opt.value = value;
		opt.textContent = label;
		this.selectEl.appendChild(opt);
		return this;
	}
	setValue(value: string) { this.selectEl.value = value; return this; }
	setDisabled(disabled: boolean) { this.selectEl.disabled = disabled; return this; }
	onChange(cb: (value: string) => void) {
		this.selectEl.addEventListener('change', () => cb(this.selectEl.value));
		return this;
	}
}

/**
 * Minimal ExtraButtonComponent (icon buttons like refresh, external link).
 */
export class ExtraButtonComponent {
	extraSettingsEl: HTMLElement;
	private buttonEl: HTMLButtonElement;

	constructor(containerEl: HTMLElement) {
		this.extraSettingsEl = enhanceElement(document.createElement('div'));
		this.buttonEl = document.createElement('button');
		this.extraSettingsEl.appendChild(this.buttonEl);
		containerEl.appendChild(this.extraSettingsEl);
	}

	setIcon(_icon: string) { return this; }
	setTooltip(_tooltip: string) { return this; }
	setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
	onClick(cb: () => void) { this.buttonEl.addEventListener('click', cb); return this; }
}

/**
 * Minimal ToggleComponent that wraps a checkbox input.
 */
export class ToggleComponent {
	toggleEl: HTMLInputElement;

	constructor(containerEl: HTMLElement) {
		this.toggleEl = document.createElement('input');
		this.toggleEl.type = 'checkbox';
		containerEl.appendChild(this.toggleEl);
	}

	setValue(value: boolean) { this.toggleEl.checked = value; return this; }
	setDisabled(disabled: boolean) { this.toggleEl.disabled = disabled; return this; }
	onChange(cb: (value: boolean) => void) {
		this.toggleEl.addEventListener('change', () => cb(this.toggleEl.checked));
		return this;
	}
}

/**
 * Minimal TextAreaComponent that wraps a real textarea element.
 */
export class TextAreaComponent {
	inputEl: HTMLTextAreaElement;

	constructor(containerEl: HTMLElement) {
		this.inputEl = document.createElement('textarea');
		containerEl.appendChild(this.inputEl);
	}

	setValue(value: string) { this.inputEl.value = value; return this; }
	setPlaceholder(ph: string) { this.inputEl.placeholder = ph; return this; }
	onChange(cb: (value: string) => void) {
		this.inputEl.addEventListener('input', () => cb(this.inputEl.value));
		return this;
	}
}

/**
 * Setting class that creates real DOM elements and invokes callbacks.
 * This enables behavior-driven testing via actual DOM events.
 */
export class Setting {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		this.settingEl = enhanceElement(document.createElement('div'));
		this.settingEl.className = 'setting-item';
		this.nameEl = enhanceElement(document.createElement('div'));
		this.nameEl.className = 'setting-item-name';
		this.descEl = enhanceElement(document.createElement('div'));
		this.descEl.className = 'setting-item-description';
		this.controlEl = enhanceElement(document.createElement('div'));
		this.controlEl.className = 'setting-item-control';
		this.settingEl.appendChild(this.nameEl);
		this.settingEl.appendChild(this.descEl);
		this.settingEl.appendChild(this.controlEl);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string) { this.nameEl.textContent = name; return this; }
	setDesc(desc: string) { this.descEl.textContent = desc; return this; }
	setHeading() { this.settingEl.classList.add('setting-item-heading'); return this; }

	addButton(cb: (button: ButtonComponent) => void) {
		cb(new ButtonComponent(this.controlEl));
		return this;
	}

	addText(cb: (text: TextComponent) => void) {
		cb(new TextComponent(this.controlEl));
		return this;
	}

	addDropdown(cb: (dropdown: DropdownComponent) => void) {
		cb(new DropdownComponent(this.controlEl));
		return this;
	}

	addExtraButton(cb: (button: ExtraButtonComponent) => void) {
		cb(new ExtraButtonComponent(this.controlEl));
		return this;
	}

	addToggle(cb: (toggle: ToggleComponent) => void) {
		cb(new ToggleComponent(this.controlEl));
		return this;
	}

	addTextArea(cb: (textarea: TextAreaComponent) => void) {
		cb(new TextAreaComponent(this.controlEl));
		return this;
	}
}
