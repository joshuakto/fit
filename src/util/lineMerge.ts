import { diff3Merge } from 'node-diff3';

export function tryLineMerge(base: string, local: string, remote: string): string | null {
	if (local === remote) return local;
	const regions = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'), { excludeFalseConflicts: true });
	if (regions.some(r => 'conflict' in r)) return null;
	return regions.flatMap(r => r.ok ?? []).join('\n');
}
