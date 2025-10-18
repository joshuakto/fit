/**
 * Tests to cover behaviors in the FitSync + real Fit components.
 *
 * These cover orchestration behaviors at the FitSync level but using the real impls of
 * Fit/FitPush/FitPull instead of test doubles, only swapping out lower-level IVault deps to avoid
 * overcomplicating them with non-orchestration details and keep them remote-agnostic.
 */

import { FitSync } from './fitSync';
import { Fit } from './fit';
import { Vault } from 'obsidian';
import { FakeLocalVault, FakeRemoteVault } from './testUtils';
import { FitSettings, LocalStores } from '../main';
import { VaultError } from './vault';

describe('FitSync w/ real Fit', () => {
	let localVault: FakeLocalVault;
	let remoteVault: FakeRemoteVault;
	let localStoreState: LocalStores;

	// Realistic settings that get passed through to RemoteGitHubVault
	const testSettings = {
		pat: 'fake-test-token',
		owner: 'test-owner',
		repo: 'test-repo',
		branch: 'test-branch',
		deviceName: 'test-device'
	};

	function createFit(initialLocalStoreState: LocalStores) : Fit {
		const fit = new Fit(
			testSettings as FitSettings,
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
			const errorMessage = fitSync.getSyncErrorMessage(result.error);
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
		remoteVault = new FakeRemoteVault(testSettings.owner, testSettings.repo, testSettings.branch);

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
		// Simulate VaultError with network type (network connectivity issue)
		const networkError = VaultError.network("Couldn't reach GitHub API");
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
		expect(successResult).toMatchObject({
			success: true,
			ops: expect.arrayContaining([
				{
					heading: expect.stringContaining('Remote file updates'),
					ops: expect.arrayContaining([
						expect.objectContaining({ path: 'fileA.md', status: 'created' }),
						expect.objectContaining({ path: 'fileB.md', status: 'created' })
					])
				}
			])
		});

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

	it('should exclude _fit/ directory from sync operations', async () => {
		// === SETUP: Initial synced state ===
		const fitSync = createFitSync();

		// === STEP 1: Create files in _fit/ directory locally ===
		localVault.setFile('_fit/conflict.md', 'Remote version saved locally');
		localVault.setFile('_fit/nested/file.md', 'Another conflict');
		localVault.setFile('normal.md', 'Normal file content');

		// === STEP 2: Attempt sync - should push normal.md but exclude _fit/ files ===
		const mockNotice1 = createMockNotice();
		const result1 = await syncAndHandleResult(fitSync, mockNotice1);

		// Verify: Only normal.md was pushed, _fit/ files excluded
		expect(result1).toMatchObject({
			success: true,
			ops: expect.arrayContaining([
				{
					heading: expect.stringContaining('Remote file updates'),
					ops: [expect.objectContaining({ path: 'normal.md', status: 'created' })]
				}
			])
		});

		// Verify: Remote does NOT have _fit/ files
		expect(remoteVault.getAllPaths()).toEqual(['normal.md']);

		// === STEP 3: Simulate another device pushing files (including _fit/ edge case) ===
		// Manually add files and trigger commit SHA update by calling applyChanges
		await remoteVault.applyChanges([
			{ path: '_fit/remote-conflict.md', content: 'Should not sync down' },
			{ path: 'remote-normal.md', content: 'Normal remote file' }
		], []);

		// === STEP 4: Attempt sync - should pull remote-normal.md but exclude _fit/ files ===
		const mockNotice2 = createMockNotice();
		const result2 = await syncAndHandleResult(fitSync, mockNotice2);

		// Verify: Only remote-normal.md was pulled, _fit/ file excluded
		expect(result2).toMatchObject({
			success: true,
			ops: [
				{
					heading: expect.stringContaining('Local file updates'),
					ops: [expect.objectContaining({ path: 'remote-normal.md', status: 'created' })]
				},
			]
		});

		// Verify: Local does NOT have the remote _fit/ file
		expect(localVault.getFile('_fit/remote-conflict.md')).toBeUndefined();
		// But local still has its original _fit/ files (those are local-only)
		expect(localVault.getFile('_fit/conflict.md')).toBe('Remote version saved locally');
		expect(localVault.getFile('_fit/nested/file.md')).toBe('Another conflict');
		// And has the normal remote file
		expect(localVault.getFile('remote-normal.md')).toBe('Normal remote file');

		// Verify: LocalStores only track synced files (no _fit/ paths)
		expect(Object.keys(localStoreState.localSha).sort()).toEqual(['normal.md', 'remote-normal.md']);
		expect(Object.keys(localStoreState.lastFetchedRemoteSha).sort()).toEqual(['normal.md', 'remote-normal.md']);
	});

	describe('Error Handling', () => {
		it('should handle network errors with user-friendly message', async () => {
			// Arrange
			const fitSync = createFitSync();
			localVault.setFile('test.md', 'content');
			const networkError = VaultError.network("Couldn't reach GitHub API");
			remoteVault.setFailure(networkError);

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify user-friendly error message
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Performing pre sync checks.'] },
				{ method: 'setMessage', args: [
					"Sync failed: Couldn't reach GitHub API. Please check your internet connection.",
					true
				]}
			]);
		});

		it('should handle authentication errors with user-friendly message', async () => {
			// Arrange
			const fitSync = createFitSync();
			localVault.setFile('test.md', 'content');
			const authError = VaultError.authentication('Bad credentials');
			remoteVault.setFailure(authError);

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify user-friendly error message
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Performing pre sync checks.'] },
				{ method: 'setMessage', args: [
					"Sync failed: Bad credentials. Check your GitHub personal access token.",
					true
				]}
			]);
		});

		it('should handle remote not found errors with user-friendly message', async () => {
			// Arrange
			const fitSync = createFitSync();
			localVault.setFile('test.md', 'content');
			const notFoundError = VaultError.remoteNotFound("Repository 'owner/repo' not found");
			remoteVault.setFailure(notFoundError);

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify user-friendly error message
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Performing pre sync checks.'] },
				{ method: 'setMessage', args: [
					"Sync failed: Repository 'owner/repo' not found. Check your repo and branch settings.",
					true
				]}
			]);
		});

		it('should handle filesystem errors with user-friendly message', async () => {
			// Arrange - simulate a pull scenario where applying changes fails
			const fitSync = createFitSync();
			remoteVault.setFile('test.md', 'remote content');

			// Make localVault.applyChanges throw a filesystem error
			const fsError = new Error("EACCES: permission denied, write 'test.md'");
			localVault.setFailure(fsError);

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify user-friendly error message
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Performing pre sync checks.'] },
				{ method: 'setMessage', args: [
					"Sync failed: File system error: EACCES: permission denied, write 'test.md'",
					true
				]}
			]);
		});
	});
});
