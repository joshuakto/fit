/**
 * Tests to cover behaviors in the FitSync + real Fit components.
 *
 * These cover orchestration behaviors at the FitSync level but using the real impls of
 * Fit/FitPush/FitPull instead of test doubles, only swapping out lower-level IVault deps to avoid
 * overcomplicating them with non-orchestration details and keep them remote-agnostic.
 */

import { FitSync } from './fitSync';
import { Fit, OctokitHttpError } from './fit';
import { Vault } from 'obsidian';
import { FakeLocalVault, FakeRemoteVault } from './testUtils';
import { FitSettings, LocalStores } from '../main';

describe('FitSync w/ real Fit', () => {
	let localVault: FakeLocalVault;
	let remoteVault: FakeRemoteVault;
	let localStoreState: LocalStores;

	function createFit(initialLocalStoreState: LocalStores) : Fit {
		const fit = new Fit(
			{} as FitSettings,
			initialLocalStoreState,
			{} as unknown as Vault);
		// Replace with fake implementations for testing
		fit.localVault = localVault as any;
		fit.remoteVault = remoteVault as any;

		return fit;
	}

	function createFitSync() : FitSync {
		const fit = createFit(localStoreState);
		const saveLocalStoreCallback = async (updates: Partial<LocalStores>) => {
			// Update the shared state object so test assertions can verify the updates
			Object.assign(localStoreState, updates);
			// Also update Fit's internal state to maintain consistency
			fit.loadLocalStore(localStoreState);
			return Promise.resolve();
		};
		return new FitSync(fit, saveLocalStoreCallback);
	}

	/**
	 * Create a mock notice that records all method calls in sequence.
	 * Returns both the mock notice and an array of recorded calls for verification.
	 */
	function createMockNotice() {
		const calls: Array<{method: string, args: any[]}> = [];

		const mockNotice = {
			setMessage: jest.fn((...args: any[]) => {
				calls.push({ method: 'setMessage', args });
			}),
			remove: jest.fn((...args: any[]) => {
				calls.push({ method: 'remove', args });
			}),
			// Expose the calls array for verification
			_calls: calls
		};

		return mockNotice;
	}

	/**
	 * Simulate main.ts sync result handling logic.
	 * This covers error handling and user notification that currently lives outside FitSync.
	 * TODO: Expand to handle success cases with conflict notifications (showUnappliedConflicts)
	 */
	async function syncAndHandleResult(fitSync: FitSync, notice: any) {
		const result = await fitSync.sync(notice);

		if (!result.success) {
			// Generate user-friendly message from structured sync error
			const errorMessage = fitSync.fit.getSyncErrorMessage(result.error);
			const fullMessage = `Sync failed: ${errorMessage}`;

			// Show error to user (second param = true means sticky/error state)
			notice.setMessage(fullMessage, true);
		} else {
			// TODO: Simulate conflict handling for success cases
			// if (result.ops) {
			//   showUnappliedConflicts(result.ops);
			// }
		}

		return result;
	}

	beforeEach(() => {
		// Create fresh vault instances for each test
		localVault = new FakeLocalVault();
		remoteVault = new FakeRemoteVault();

		// Initialize local store state (empty/synced state)
		// Note: localStoreState is hoisted to test scope so assertions can verify its updates
		localStoreState = {
			localSha: {},
			lastFetchedRemoteSha: {},
			lastFetchedCommitSha: 'commit-initial'
		};
	});

	it('should only sync accumulated changes after failed sync, not report stale changes', async () => {
		// === SETUP: Initial synced state (empty vault) ===
		const fitSync = createFitSync();

		// === STEP 1: Add file A locally ===
		localVault.setFile('fileA.md', 'Content of file A');

		// === STEP 2: Attempt sync - FAILS during push (network error) ===
		// Simulate OctokitHttpError with status=null (network connectivity issue)
		const networkError = new OctokitHttpError(
			"Couldn't reach GitHub API",
			null,  // null status indicates network error
			'getRemoteTreeSha'
		);
		remoteVault.setFailure(networkError);

		// Verify: Sync failed and error was shown to user
		const mockNotice1 = createMockNotice();
		await syncAndHandleResult(fitSync, mockNotice1);
		expect(mockNotice1._calls).toEqual([
			{ method: 'setMessage', args: ['Performing pre sync checks.'] },
			{ method: 'setMessage', args: [
				"Sync failed: Couldn't reach GitHub API. Please check your internet connection.",
				true  // isError - sticky/error state
			]}
		]);

		// Verify: LocalStores NOT updated
		expect(localStoreState).toEqual({
			localSha: {}, // Still empty
			lastFetchedCommitSha: 'commit-initial', // Unchanged
			lastFetchedRemoteSha: {}, // Still empty
		});

		// Verify: Remote not updated
		expect(remoteVault.getAllPaths()).toEqual([]); // Still empty

		// === STEP 3: Add file B locally (A still exists) ===
		localVault.setFile('fileB.md', 'Content of file B');

		// === STEP 4: Retry sync - SUCCEEDS (no failure set on vaults) ===
		const mockNotice2 = createMockNotice();
		const successResult = await syncAndHandleResult(fitSync, mockNotice2);
		expect(mockNotice2._calls).toEqual([
			{ method: 'setMessage', args: ['Performing pre sync checks.'] },
			{ method: 'setMessage', args: ['Uploading local changes'] },
			{ method: 'setMessage', args: ['Writing remote changes to local'] },
			{ method: 'setMessage', args: ['Sync successful'] }
		]);

		// Verify: Both files A and B were synced (both are new vs baseline)
		const ops = successResult.success ? successResult.ops : [];
		const pushedOps = ops.find(o => o.heading?.includes('Remote file updates'))?.ops || [];
		expect(pushedOps).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: 'fileA.md', status: 'created' }),
			expect.objectContaining({ path: 'fileB.md', status: 'created' })
		]));
		expect(pushedOps.length).toBe(2);

		// Verify: LocalStores updated with BOTH files
		expect(localStoreState).toEqual({
			localSha: {
				'fileA.md': expect.anything(),
				'fileB.md': expect.anything()
			},
			lastFetchedCommitSha: expect.not.stringMatching('initial-commit'),
			lastFetchedRemoteSha: {
				'fileA.md': expect.anything(),
				'fileB.md': expect.anything()
			}
		});

		// Verify: Remote has new commit and both files
		expect(remoteVault.getAllPaths().sort()).toEqual(['fileA.md', 'fileB.md']);
		expect(remoteVault.getCommitSha()).not.toBe('initial-commit');
	});
});
