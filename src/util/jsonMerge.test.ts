import { describe, it, expect } from 'vitest';
import { mergeJson, serialiseMerged, CANVAS_MERGE_SPEC, type JsonMergeSpec } from './jsonMerge';

describe('mergeJson', () => {
	describe('error handling', () => {
		it('returns failure when local is not valid JSON', () => {
			const result = mergeJson(null, 'not json', '{}', CANVAS_MERGE_SPEC);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('local') });
		});

		it('returns failure when remote is not valid JSON', () => {
			const result = mergeJson(null, '{}', 'not json', CANVAS_MERGE_SPEC);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('remote') });
		});

		it('returns failure when local root is an array', () => {
			const result = mergeJson(null, '[]', '{}', CANVAS_MERGE_SPEC);
			expect(result).toEqual(expect.objectContaining({ merged: false }));
		});

		it('returns failure when remote root is an array', () => {
			const result = mergeJson(null, '{}', '[]', CANVAS_MERGE_SPEC);
			expect(result).toEqual(expect.objectContaining({ merged: false }));
		});
	});

	describe('keyed array merge', () => {
		const spec: JsonMergeSpec = { keyedArrays: { items: 'id' } };

		it('remote-only additions appear in result', () => {
			const local = JSON.stringify({ items: [{ id: 'a', val: 1 }] });
			const remote = JSON.stringify({ items: [{ id: 'a', val: 1 }, { id: 'b', val: 2 }] });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.items).toEqual([
				expect.objectContaining({ id: 'a' }),
				expect.objectContaining({ id: 'b' }),
			]);
		});

		it('local-only additions are appended after remote items', () => {
			const local = JSON.stringify({ items: [{ id: 'a' }, { id: 'c' }] });
			const remote = JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.items).toEqual([
				expect.objectContaining({ id: 'a' }),
				expect.objectContaining({ id: 'b' }),
				expect.objectContaining({ id: 'c' }),
			]);
		});

		it('same-id conflict with different content returns failure (caller falls back to clash file)', () => {
			const local = JSON.stringify({ items: [{ id: 'a', val: 'local' }] });
			const remote = JSON.stringify({ items: [{ id: 'a', val: 'remote' }] });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('a') });
		});

		it('same-id with identical content is not a conflict', () => {
			const local = JSON.stringify({ items: [{ id: 'a', val: 'same' }] });
			const remote = JSON.stringify({ items: [{ id: 'a', val: 'same' }] });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.items).toEqual([{ id: 'a', val: 'same' }]);
		});

		it('independent adds from both sides are all present', () => {
			const local = JSON.stringify({ items: [{ id: 'a' }, { id: 'c' }] });
			const remote = JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.items).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: 'a' }),
				expect.objectContaining({ id: 'b' }),
				expect.objectContaining({ id: 'c' }),
			]));
		});

		it('remote order is preserved for shared and remote-only items', () => {
			const local = JSON.stringify({ items: [{ id: 'b' }, { id: 'a' }] });
			const remote = JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
			const result = mergeJson(null, local, remote, spec);
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.items).toEqual([
				expect.objectContaining({ id: 'a' }),
				expect.objectContaining({ id: 'b' }),
				expect.objectContaining({ id: 'c' }),
			]);
		});

		it('items without id key are kept from remote, not duplicated', () => {
			const local = JSON.stringify({ items: [{ noId: 'local' }] });
			const remote = JSON.stringify({ items: [{ noId: 'remote' }] });
			const result = mergeJson(null, local, remote, spec);
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.items).toEqual([{ noId: 'remote' }]);
		});

		it('non-keyed top-level key conflict falls back to clash', () => {
			const local = JSON.stringify({ items: [], meta: 'local-meta' });
			const remote = JSON.stringify({ items: [], meta: 'remote-meta' });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('meta') });
		});

		it('non-keyed top-level key with same value on both sides merges cleanly', () => {
			const local = JSON.stringify({ items: [], meta: 'shared' });
			const remote = JSON.stringify({ items: [], meta: 'shared' });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.meta).toBe('shared');
		});

		it('one-sided keyed array without base falls back (ambiguous addition vs deletion)', () => {
			const local = JSON.stringify({ items: [{ id: 'a' }] });
			const remote = JSON.stringify({});
			const result = mergeJson(null, local, remote, spec);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('items') });
		});

		it('remote-only keyed array without base falls back (ambiguous addition vs deletion)', () => {
			const local = JSON.stringify({});
			const remote = JSON.stringify({ items: [{ id: 'a' }] });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('items') });
		});
	});

	describe('CANVAS_MERGE_SPEC', () => {
		const node = (id: string, x = 0, y = 0) => ({ id, type: 'file', file: `${id}.md`, x, y, width: 400, height: 400 });
		const edge = (id: string, from: string, to: string) => ({ id, fromNode: from, fromSide: 'right', toNode: to, toSide: 'left' });

		it('independent node additions auto-resolve', () => {
			const local = JSON.stringify({ nodes: [node('a')], edges: [] });
			const remote = JSON.stringify({ nodes: [node('a'), node('b')], edges: [] });
			const result = mergeJson(null, local, remote, CANVAS_MERGE_SPEC);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.nodes).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: 'a' }),
				expect.objectContaining({ id: 'b' }),
			]));
		});

		it('conflicting node edits (same id, different position) fall back to clash', () => {
			const local = JSON.stringify({ nodes: [node('a', 100, 200)], edges: [] });
			const remote = JSON.stringify({ nodes: [node('a', 0, 0)], edges: [] });
			const result = mergeJson(null, local, remote, CANVAS_MERGE_SPEC);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('a') });
		});

		it('edge additions from both sides are merged', () => {
			const local = JSON.stringify({ nodes: [], edges: [edge('e1', 'a', 'b')] });
			const remote = JSON.stringify({ nodes: [], edges: [edge('e2', 'b', 'c')] });
			const result = mergeJson(null, local, remote, CANVAS_MERGE_SPEC);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.edges).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: 'e1' }),
				expect.objectContaining({ id: 'e2' }),
			]));
		});

		it('unknown top-level key conflict falls back to clash', () => {
			const local = JSON.stringify({ nodes: [], edges: [], unknownFutureKey: 'local' });
			const remote = JSON.stringify({ nodes: [], edges: [], unknownFutureKey: 'remote' });
			const result = mergeJson(null, local, remote, CANVAS_MERGE_SPEC);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('unknownFutureKey') });
		});

		it('empty canvas merges cleanly', () => {
			const empty = JSON.stringify({ nodes: [], edges: [] });
			const result = mergeJson(null, empty, empty, CANVAS_MERGE_SPEC);
			expect(result).toEqual(expect.objectContaining({ merged: true }));
			const merged = (result as { merged: true; value: unknown }).value as any;
			expect(merged.nodes).toHaveLength(0);
			expect(merged.edges).toHaveLength(0);
		});
	});
});

describe('serialiseMerged', () => {
	it('produces tab-indented JSON matching Obsidian canvas format', () => {
		const value = { nodes: [{ id: 'a' }], edges: [] };
		const out = serialiseMerged(value);
		expect(out).toContain('\t');
		expect(JSON.parse(out)).toEqual(value);
	});
});
