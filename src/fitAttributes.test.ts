/**
 * Covers .fitattributes.json parsing/validation only (parseFitAttributes).
 * Not covered here: applying rules during sync, field-level JSON masking —
 * see docs/sync-logic.md § `.fitattributes.json` (#337).
 */
import { describe, it, expect } from 'vitest';
import { parseFitAttributes } from '@/fitAttributes';

describe('parseFitAttributes', () => {
	it('parses a valid multi-path config', () => {
		const text = JSON.stringify({
			'.obsidian/core-plugins.json': {},
			'.obsidian/community-plugins.json': { format: 'json' },
		});
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: {
				'.obsidian/core-plugins.json': {},
				'.obsidian/community-plugins.json': { format: 'json' },
			},
		});
	});

	it('treats an empty rule as simply "opted in" with default handling', () => {
		const text = JSON.stringify({ '.obsidian/appearance.json': {} });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/appearance.json': {} },
		});
	});

	it('rejects malformed JSON', () => {
		const result = parseFitAttributes('{not json');
		expect(result.ok).toBe(false);
	});

	it.each([
		['array', '[]'],
		['string', '"foo"'],
		['number', '1'],
		['null', 'null'],
	])('rejects a %s root', (_label, text) => {
		expect(parseFitAttributes(text)).toEqual(
			expect.objectContaining({ ok: false }),
		);
	});

	it('rejects a rule that is not an object', () => {
		const text = JSON.stringify({ '.obsidian/graph.json': ['not', 'an', 'object'] });
		expect(parseFitAttributes(text)).toEqual(
			expect.objectContaining({ ok: false }),
		);
	});

	it('accepts format: "json"', () => {
		const text = JSON.stringify({ '.obsidian/graph.json': { format: 'json' } });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/graph.json': { format: 'json' } },
		});
	});

	it('accepts format: "text"', () => {
		const text = JSON.stringify({ '.obsidian/snippets/custom.css': { format: 'text' } });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/snippets/custom.css': { format: 'text' } },
		});
	});

	it('rejects an unrecognized format value', () => {
		const text = JSON.stringify({ '.obsidian/graph.json': { format: 'yaml' } });
		expect(parseFitAttributes(text)).toEqual(
			expect.objectContaining({ ok: false }),
		);
	});
});
