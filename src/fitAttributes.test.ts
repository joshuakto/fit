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
			invalidRules: [],
		});
	});

	it('accepts an empty rule object, with all fields left to their defaults', () => {
		const text = JSON.stringify({ '.obsidian/appearance.json': {} });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/appearance.json': {} },
			invalidRules: [],
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

	it.each([
		['is not an object', ['not', 'an', 'object'], 'rule for ".obsidian/bad.json" must be an object'],
		['has an unrecognized format', { format: 'yaml' }, 'rule for ".obsidian/bad.json": "format" must be "json" or "text" if present'],
		['has an unrecognized scope', { format: 'json', scope: 'partial' }, 'rule for ".obsidian/bad.json": "scope" must be "full" or "subset" if present'],
	])('drops only the rule that %s, keeping the valid rules around it', (_label, badRule, expectedError) => {
		const text = JSON.stringify({
			'.obsidian/a.json': { format: 'json' },
			'.obsidian/bad.json': badRule,
			'.obsidian/z.css': { format: 'text' },
		});
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: {
				'.obsidian/a.json': { format: 'json' },
				'.obsidian/z.css': { format: 'text' },
			},
			invalidRules: [{ path: '.obsidian/bad.json', error: expectedError }],
		});
	});

	it('drops a rule with one invalid field entirely instead of keeping its valid field', () => {
		// Keeping { format: "json" } alone would silently activate behavior the author
		// didn't finish specifying (scope defaults differ from an explicit one).
		const text = JSON.stringify({ '.obsidian/graph.json': { format: 'json', scope: 'partial' } });
		expect(parseFitAttributes(text)).toEqual(expect.objectContaining({ ok: true, value: {} }));
	});

	it('reports every invalid rule, not just the first', () => {
		const text = JSON.stringify({ 'a.json': 'x', 'b.json': { format: 'yaml' } });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: {},
			invalidRules: [
				{ path: 'a.json', error: 'rule for "a.json" must be an object' },
				{ path: 'b.json', error: 'rule for "b.json": "format" must be "json" or "text" if present' },
			],
		});
	});

	it('accepts format: "json"', () => {
		const text = JSON.stringify({ '.obsidian/graph.json': { format: 'json' } });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/graph.json': { format: 'json' } },
			invalidRules: [],
		});
	});

	it('accepts format: "text"', () => {
		const text = JSON.stringify({ '.obsidian/snippets/custom.css': { format: 'text' } });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/snippets/custom.css': { format: 'text' } },
			invalidRules: [],
		});
	});

	it('accepts scope: "full" alongside format: "json"', () => {
		const text = JSON.stringify({ '.obsidian/graph.json': { format: 'json', scope: 'full' } });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/graph.json': { format: 'json', scope: 'full' } },
			invalidRules: [],
		});
	});

	it('accepts scope: "subset"', () => {
		const text = JSON.stringify({ '.obsidian/graph.json': { format: 'json', scope: 'subset' } });
		expect(parseFitAttributes(text)).toEqual({
			ok: true,
			value: { '.obsidian/graph.json': { format: 'json', scope: 'subset' } },
			invalidRules: [],
		});
	});
});
