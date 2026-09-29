import { describe, it, expect } from 'vitest';
import { mergeJson, serialiseMerged, mergeSpecForPath, CANVAS_MERGE_SPEC, GENERIC_JSON_MERGE_SPEC, type JsonMergeSpec } from './jsonMerge';

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

		it('three-way: remote unchanged from base → local edit wins', () => {
			const base = JSON.stringify({ items: [{ id: 'a', val: 'base' }] });
			const local = JSON.stringify({ items: [{ id: 'a', val: 'local' }] });
			const remote = JSON.stringify({ items: [{ id: 'a', val: 'base' }] }); // remote unchanged
			const result = mergeJson(base, local, remote, spec);
			expect(result).toEqual({ merged: true, value: { items: [{ id: 'a', val: 'local' }] } });
		});

		it('three-way: local unchanged from base → remote edit wins', () => {
			const base = JSON.stringify({ items: [{ id: 'a', val: 'base' }] });
			const local = JSON.stringify({ items: [{ id: 'a', val: 'base' }] }); // local unchanged
			const remote = JSON.stringify({ items: [{ id: 'a', val: 'remote' }] });
			const result = mergeJson(base, local, remote, spec);
			expect(result).toEqual({ merged: true, value: { items: [{ id: 'a', val: 'remote' }] } });
		});

		it('three-way: both sides changed same item → genuine conflict', () => {
			const base = JSON.stringify({ items: [{ id: 'a', val: 'base' }] });
			const local = JSON.stringify({ items: [{ id: 'a', val: 'local' }] });
			const remote = JSON.stringify({ items: [{ id: 'a', val: 'remote' }] });
			const result = mergeJson(base, local, remote, spec);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('a') });
		});

		it('remote deletion of an item local left unchanged doesn\'t yet reconcile as deleted (TODO)', () => {
			const itemA = { id: 'a', val: 'base' };
			const itemB = { id: 'b', val: 'base' };
			const base = JSON.stringify({ items: [itemA, itemB] });
			const local = base; // unchanged from base
			const remote = JSON.stringify({ items: [itemA] }); // remote deleted 'b'
			const result = mergeJson(base, local, remote, spec);
			// mergeKeyedArrays never consults base for an id missing from one side, so it
			// resurrects 'b' from local's copy instead of reconciling the deletion.
			// TODO: should be { merged: true, value: { items: [itemA] } } - the deletion is
			// unambiguous here (local never touched 'b'), same as mergeObjects' scalar-key
			// branch already does for a plain key missing on one side.
			expect(result).toEqual({ merged: true, value: { items: [itemA, itemB] } });
		});

		it('remote deletion against a local edit of same item doesn\'t yet conflict (TODO)', () => {
			const itemA = { id: 'a', val: 'base' };
			const itemB = { id: 'b', val: 'base' };
			const base = JSON.stringify({ items: [itemA, itemB] });
			const local = JSON.stringify({ items: [itemA, { ...itemB, val: 'local-edit' }] });
			const remote = JSON.stringify({ items: [itemA] }); // remote deleted 'b'
			const result = mergeJson(base, local, remote, spec);
			// Same root cause: base is never consulted, so this silently keeps local's edit
			// as if remote had simply never touched 'b', instead of flagging a real conflict
			// (one side deleted, the other edited the same item).
			// TODO: should be { merged: false, reason: expect.stringContaining('b') }.
			expect(result).toEqual({ merged: true, value: { items: [itemA, { id: 'b', val: 'local-edit' }] } });
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

		it('one-sided keyed array with base confirms new addition, includes it', () => {
			const base = JSON.stringify({});
			const local = JSON.stringify({ items: [{ id: 'a' }] });
			const remote = JSON.stringify({});
			const result = mergeJson(base, local, remote, spec);
			expect(result).toEqual({ merged: true, value: { items: [{ id: 'a' }] } });
		});

		it('remote-only keyed array without base falls back (ambiguous addition vs deletion)', () => {
			const local = JSON.stringify({});
			const remote = JSON.stringify({ items: [{ id: 'a' }] });
			const result = mergeJson(null, local, remote, spec);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('items') });
		});

		it('remote-only keyed array with base confirms new addition, includes it', () => {
			const base = JSON.stringify({});
			const local = JSON.stringify({});
			const remote = JSON.stringify({ items: [{ id: 'a' }] });
			const result = mergeJson(base, local, remote, spec);
			expect(result).toEqual({ merged: true, value: { items: [{ id: 'a' }] } });
		});

		it('non-keyed key deleted by both sides is omitted from result', () => {
			const base = JSON.stringify({ staleKey: 'old' });
			const local = JSON.stringify({});
			const remote = JSON.stringify({});
			const result = mergeJson(base, local, remote, spec);
			expect(result).toEqual({ merged: true, value: {} });
		});

		it('non-keyed key conflict is still a clash when base is provided', () => {
			const base = JSON.stringify({ key: 'original' });
			const local = JSON.stringify({ key: 'local-edit' });
			const remote = JSON.stringify({ key: 'remote-edit' });
			const result = mergeJson(base, local, remote, spec);
			expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('key') });
		});

		it.each([
			{ changedSide: 'local', local: 'light', remote: 'dark', expected: 'light' },
			{ changedSide: 'remote', local: 'dark', remote: 'light', expected: 'light' },
		])('a shared key edited on only the $changedSide side (other side left it matching base) merges instead of spuriously clashing', ({ local, remote, expected }) => {
			// Regression test: mergeObjects' same-key branch used to ignore base entirely -
			// ANY two files that both changed (even in unrelated ways) would clash on every
			// key one side actually edited, since the untouched side's copy of that key was
			// never recognized as "unchanged from base", only compared byte-for-byte against
			// the other side's edit. Three-way resolution (already correct for keyed-array
			// elements, see CANVAS_MERGE_SPEC tests below) now applies here too - both
			// directions of the base-comparison exercised, since they're separate branches.
			const base = JSON.stringify({ theme: 'dark' });
			const result = mergeJson(base, JSON.stringify({ theme: local }), JSON.stringify({ theme: remote }), spec);
			expect(result).toEqual({ merged: true, value: { theme: expected } });
		});

		it('local edits an existing key while remote adds a different, unrelated new key: both merge cleanly', () => {
			// This is the actual scenario the format:"json" feature advertises ("concurrent
			// edits to different top-level keys merge instead of clashing to _fit/") - not
			// just two brand-new key additions on each side, which is all the pre-existing
			// coverage exercised.
			const base = JSON.stringify({ theme: 'dark' });
			const local = JSON.stringify({ theme: 'light' });
			const remote = JSON.stringify({ theme: 'dark', windowWidth: 1200 });
			const result = mergeJson(base, local, remote, spec);
			expect(result).toEqual({ merged: true, value: { theme: 'light', windowWidth: 1200 } });
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

describe('mergeSpecForPath', () => {
	it.each(['board.canvas', 'Board.Canvas', 'BOARD.CANVAS', 'board.CANVAS'])(
		'%s resolves to CANVAS_MERGE_SPEC regardless of case', (path) => {
			// Regression test: this used to be a case-sensitive path.endsWith('.canvas')
			// check, disagreeing with detectSyncFormat's lowercased match - a file like
			// Board.Canvas would be dispatched into the JSON-merge lane (detectSyncFormat
			// says "json") but silently get GENERIC_JSON_MERGE_SPEC instead of
			// CANVAS_MERGE_SPEC, losing the id-keyed nodes/edges union.
			expect(mergeSpecForPath(path)).toBe(CANVAS_MERGE_SPEC);
		});

	it('a non-canvas .json path resolves to GENERIC_JSON_MERGE_SPEC', () => {
		expect(mergeSpecForPath('config.json')).toBe(GENERIC_JSON_MERGE_SPEC);
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
