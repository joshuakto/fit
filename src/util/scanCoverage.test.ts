/**
 * Covers ScanCoverage only: how a local scan's state and its unscanned prefixes combine into
 * present / absent / unknown for one path (statusOf), and which prefixes that hid a path
 * (prefixesConsulted, which feeds the unlistable-paths notice). Not covered here: how Fit and
 * FitSync act on each status — see fitSync.realFit.test.ts "Hidden-path scan pruning".
 */
import { describe, it, expect } from 'vitest';
import type { FileStates } from './changeTracking';
import type { BlobSha } from './hashing';
import { ScanCoverage } from './scanCoverage';

describe('ScanCoverage.statusOf', () => {
	const state: FileStates = {
		'notes/a.md': 'sha-a' as BlobSha,
		'.mytool/seen.json': 'sha-seen' as BlobSha,
	};

	it.each([
		['present when the scan saw the path', ['.mytool'], '.mytool/seen.json', 'present'],
		['present for a scanned path even under an unscanned prefix', ['notes'], 'notes/a.md', 'present'],
		['unknown for an unseen path under an unscanned folder', ['.mytool'], '.mytool/gone.json', 'unknown'],
		['unknown for an unseen path that is the unscanned path itself', ['.mytool/.git'], '.mytool/.git', 'unknown'],
		['absent for an unseen path outside every unscanned prefix', ['.mytool'], 'other/b.md', 'absent'],
		['absent for a sibling whose name only shares the prefix text', ['.mytool'], '.mytool2/c.json', 'absent'],
		['unknown for an unseen hidden path when the whole scan root is unscanned', ['/'], '.obsidian/app.json', 'unknown'],
		['absent for an unseen ordinary path when the whole scan root is unscanned', ['/'], 'missing.md', 'absent'],
		['absent when nothing was left unscanned', [], '.mytool/gone.json', 'absent'],
	])('%s', (_label, unscannedPrefixes, path, expected) => {
		const coverage = new ScanCoverage(state, new Set(unscannedPrefixes));

		expect({ path, status: coverage.statusOf(path) }).toEqual({ path, status: expected });
	});
});

describe('ScanCoverage.prefixesConsulted', () => {
	const state: FileStates = { '.mytool/seen.json': 'sha-seen' as BlobSha };

	it.each([
		['nothing before any lookup', [] as string[], []],
		['nothing for a path the scan saw', ['.mytool/seen.json'], []],
		['nothing for a path outside every unscanned prefix', ['other/b.md'], []],
		['the prefix that hid an unseen path', ['.mytool/gone.json'], ['.mytool']],
		['every prefix that hid the same path', ['.mytool/gone.json', '.mytool/x/y.json'], ['.mytool']],
	])('reports %s', (_label, lookups, expected) => {
		const coverage = new ScanCoverage(state, new Set(['.mytool', '.other']));
		lookups.forEach(path => coverage.statusOf(path));

		expect([...coverage.prefixesConsulted()]).toEqual(expected);
	});

	it('reports both a folder and the root when a hidden path sits under both', () => {
		const coverage = new ScanCoverage(state, new Set(['.mytool', '/']));
		coverage.statusOf('.mytool/gone.json');

		expect([...coverage.prefixesConsulted()].sort()).toEqual(['.mytool', '/']);
	});
});
