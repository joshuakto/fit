import type { FileStates } from '@/util/changeTracking';
import { isUnderAnyPrefix } from '@/util/filePath';

/**
 * What a local scan can say about one path:
 * - `present`: the scan saw it (it is in the scan's state).
 * - `unknown`: the scan did not look where it would be (a pruned folder, a folder the
 *   adapter could not list, or the whole adapter walk), so its absence from the state
 *   means nothing. A stored baseline entry or a remote change for it must be left alone.
 * - `absent`: the scan looked and it is not there.
 */
export type PathScanStatus = 'present' | 'absent' | 'unknown';

/**
 * One local scan's state together with the prefixes it did not scan, so callers ask
 * "can I trust this scan about that path" in one place instead of each re-deriving it
 * from a prefix set (docs/sync-logic.md § Scan-time pruning vs. the stored baseline).
 */
export class ScanCoverage {
	constructor(
		private readonly state: FileStates,
		private readonly unscannedPrefixes: ReadonlySet<string>
	) {}

	statusOf(path: string): PathScanStatus {
		if (Object.prototype.hasOwnProperty.call(this.state, path)) return 'present';
		return isUnderAnyPrefix(path, this.unscannedPrefixes) ? 'unknown' : 'absent';
	}
}
