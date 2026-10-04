import { diff3Merge } from 'node-diff3';

/**
 * Three-way line merge for text clashes: the merged text, or null when any region truly
 * conflicts. See docs/sync-logic.md § Line-Based Text Merge.
 */
export function tryLineMerge(base: string, local: string, remote: string): string | null {
	if (local === remote) return local;
	const regions = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'), { excludeFalseConflicts: true });
	if (regions.some(r => 'conflict' in r)) return null;
	return regions.flatMap(r => r.ok ?? []).join('\n');
}
