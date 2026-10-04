/**
 * Covers ScanCoverage.statusOf only: how a local scan's state and its unscanned prefixes
 * combine into present / absent / unknown for one path. Not covered here: how Fit and
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
