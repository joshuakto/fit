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

describe('FitSync w/ real Fit', () => {
	let localVault: FakeLocalVault;
	let remoteVault: FakeRemoteVault;
	let localStoreState: Partial<LocalStores>;
	let saveLocalStoreCallback: jest.Mock;

	function createFitForScenario() : Fit {
		// Create mock vault (not used by fakes, but required by Fit constructor)
		const mockVault = {
			getFiles: jest.fn().mockReturnValue([]),
			read: jest.fn(),
		} as unknown as jest.Mocked<Vault>;

		const fit = new Fit(
			{} as FitSettings,
			localStoreState as LocalStores,
			mockVault);
		// Replace with fake implementations for testing
		fit.localVault = localVault as any;
		fit.remoteVault = remoteVault as any;

		return fit;
	}

	beforeEach(() => {
		// Create fresh vault instances for each test
		localVault = new FakeLocalVault();
		remoteVault = new FakeRemoteVault();

		// Initialize local store state (empty/synced state)
		localStoreState = {
			localSha: {},
			lastFetchedRemoteSha: {},
			lastFetchedCommitSha: 'commit-initial'
		};

		// Track calls to saveLocalStore
		saveLocalStoreCallback = jest.fn((updates: Partial<LocalStores>) => {
			localStoreState = { ...localStoreState, ...updates };
			return Promise.resolve();
		});
	});

	it('should only sync accumulated changes after failed sync, not report stale changes', async () => {
		// === SETUP: Initial synced state (empty vault) ===
		const fit = createFitForScenario();
		const fitSync = new FitSync(fit, saveLocalStoreCallback);
		const mockNotice1 = { setMessage: jest.fn() } as any;

		// === STEP 1: Add file A locally ===
		localVault.setFile('fileA.md', 'Content of file A');

		// === STEP 2: Attempt sync - FAILS during push ===
		remoteVault.setFailure(new Error('Push failed: network error'));

		const failedResult = await fitSync.sync(mockNotice1);

		// Verify: Sync failed
		expect(failedResult.success).toBe(false);

		// Verify: LocalStores NOT updated (no saveLocalStoreCallback with success state)
		expect(localStoreState.localSha).toEqual({}); // Still empty
		expect(localStoreState.lastFetchedCommitSha).toBe('commit-initial'); // Unchanged

		// Verify: Notice messages include all expected.
		expect(mockNotice1.setMessage.mock.calls).toEqual([
			['Performing pre sync checks.']
		]);

		// === STEP 3: Add file B locally (A still exists) ===
		localVault.setFile('fileB.md', 'Content of file B');

		// === STEP 4: Retry sync - SUCCEEDS (no failure set on vaults) ===
		const mockNotice2 = { setMessage: jest.fn() } as any;
		const successResult = await fitSync.sync(mockNotice2);

		// Verify: Sync succeeded
		if (!successResult.success) {
			throw new Error(`Expected successful sync result, got: ${JSON.stringify(successResult.error)}`);
		}

		// Verify: Both files A and B were synced (both are new vs baseline)
		const pushedOps = successResult.ops?.find(o => o.heading?.includes('Remote file updates'))?.ops || [];
		expect(pushedOps).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: 'fileA.md', status: 'created' }),
			expect.objectContaining({ path: 'fileB.md', status: 'created' })
		]));
		expect(pushedOps.length).toBe(2);

		// Verify: Notice messages include all expected.
		expect(mockNotice2.setMessage.mock.calls).toEqual([
			['Performing pre sync checks.'],
			['Uploading local changes'],
			['Writing remote changes to local'],
			['Sync successful']
		]);

		// Verify: LocalStores updated with BOTH files
		expect(saveLocalStoreCallback).toHaveBeenCalled();
		expect(localStoreState.localSha?.['fileA.md']).toBeDefined();
		expect(localStoreState.localSha?.['fileB.md']).toBeDefined();

		// Verify: Remote has both files
		expect(remoteVault.getAllPaths().sort()).toEqual(['fileA.md', 'fileB.md']);

		// Verify: New commit was created
		expect(localStoreState.lastFetchedCommitSha).not.toBe('commit-initial');
		expect(remoteVault.getCommitSha()).not.toBe('initial-commit');
	});
});
