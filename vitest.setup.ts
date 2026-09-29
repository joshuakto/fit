// Vitest setup file - runs before all tests

import { expect } from 'vitest';

interface JsonMatchers<R = unknown> {
	/**
	 * Asserts a string parses as JSON structurally equal to `expected` - avoids
	 * asserting on exact serialisation (indentation, key order, whitespace).
	 * Usable inline in a larger toEqual(), e.g.
	 * expect(vault.getAllFilesAsRaw()).toEqual({ 'x.json': expect.stringOfJson({a:1}) }).
	 */
	stringOfJson(expected: unknown): R;
}
declare module 'vitest' {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging, not an empty type
	interface Assertion<T = any> extends JsonMatchers<T> {}
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging, not an empty type
	interface AsymmetricMatchersContaining extends JsonMatchers {}
}

expect.extend({
	stringOfJson(received: unknown, expected: unknown) {
		if (typeof received !== 'string') {
			return { pass: false, message: () => `expected a JSON string, got ${typeof received}` };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(received);
		} catch {
			return { pass: false, message: () => `expected valid JSON, got: ${received}` };
		}
		const pass = this.equals(parsed, expected);
		return {
			pass,
			message: () =>
				`expected string parsing to JSON ${pass ? 'not ' : ''}to equal\n${JSON.stringify(expected, null, 2)}\nreceived:\n${JSON.stringify(parsed, null, 2)}`,
		};
	},
});

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
