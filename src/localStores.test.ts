/**
 * Round-trip coverage for parseLocalStore — the persisted sync state contract.
 * Scope: deserialization defaults and field round-tripping only, not sync behavior
 * (that's fitSync.test.ts's concern).
 */
import { describe, it, expect } from 'vitest';
import { parseLocalStore } from '@/localStores';
import { FileStates } from '@/util/changeTracking';
import { CommitSha } from '@/util/hashing';

describe('parseLocalStore', () => {
	it('defaults every field when given no data', () => {
		expect(parseLocalStore(null)).toEqual(expect.objectContaining({
			localShas: {},
			lastFetchedCommitSha: null,
			lastFetchedRemoteShas: {},
			unpushedFiles: {},
			pendingClashes: [],
			protectedPathShas: {},
		}));
	});

	it('round-trips localSymlinkPaths and remoteSymlinkPaths', () => {
		const data = {
			localShas: { 'a.md': 'sha1' } as unknown as FileStates,
			lastFetchedCommitSha: 'commit1' as unknown as CommitSha,
			lastFetchedRemoteShas: { 'a.md': 'sha1' } as unknown as FileStates,
			localSymlinkPaths: ['link1', 'link2'],
			remoteSymlinkPaths: ['link1'],
		};

		const parsed = parseLocalStore(data);

		expect(parsed.localSymlinkPaths).toEqual(['link1', 'link2']);
		expect(parsed.remoteSymlinkPaths).toEqual(['link1']);
	});

	it('defaults localSymlinkPaths and remoteSymlinkPaths to undefined when absent (downgrade-safe)', () => {
		const parsed = parseLocalStore({ localShas: {} });

		expect(parsed.localSymlinkPaths).toBeUndefined();
		expect(parsed.remoteSymlinkPaths).toBeUndefined();
	});
});
