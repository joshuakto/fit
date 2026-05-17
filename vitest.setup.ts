// Vitest setup file - runs before all tests

// Polyfill for HTMLOptionElement constructor (not available in happy-dom)
// This matches the native Option() constructor interface:
// new Option(text, value, defaultSelected, selected)

declare global {
	interface Window {
		Option: typeof HTMLOptionElement;
	}
}

if (typeof globalThis.Option === 'undefined') {
	globalThis.Option = class Option {
		constructor(text?: string, value?: string, defaultSelected?: boolean, selected?: boolean) {
			const option = document.createElement('option');
			if (text !== undefined) option.text = text;
			if (value !== undefined) option.value = value;
			if (defaultSelected) option.defaultSelected = true;
			if (selected) option.selected = true;
			return option;
		}
	} as unknown as typeof HTMLOptionElement;
}

// Export empty object to make this a module (required for declare global)
export {};
