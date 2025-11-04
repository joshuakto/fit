/**
 * Tests to cover behaviors in the FitSync + real Fit components.
 *
 * These cover orchestration behaviors at the FitSync level using the real impl of Fit instead of
 * test doubles, only swapping out lower-level IVault deps to avoid overcomplicating them with
 * non-orchestration details and keep them remote-agnostic.
 */

import { FitSync } from './fitSync';
import { Fit } from './fit';
import { Vault } from 'obsidian';
import { FakeLocalVault, FakeRemoteVault } from './testUtils';
import { FitSettings, LocalStores } from '../main';
import { VaultError } from './vault';
import { fitLogger } from './logger';
import { FileContent } from './util/contentEncoding';
import { BlobSha, CommitSha } from './util/hashing';

describe('FitSync', () => {
	let localVault: FakeLocalVault;
	let remoteVault: FakeRemoteVault;
	let localStoreState: LocalStores;
	let consoleLogSpy: jest.SpyInstance;
	let consoleErrorSpy: jest.SpyInstance;
	let fitLoggerLogSpy: jest.SpyInstance;
	let fitLoggerFlushSpy: jest.SpyInstance;

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

	/**
	 * Helper to find and verify a specific fitLogger.log() call.
	 * Shows a clear diff if the message is found but metadata doesn't match.
	 */
	function expectLoggerCalledWith(message: string, expectedMetadata: any) {
		const allCalls = fitLoggerLogSpy.mock.calls;
		const matchingCall = allCalls.find(call => call[0] === message);

		if (!matchingCall) {
			// Message not found - show which messages were logged
			const loggedMessages = allCalls.map(call => call[0]);
			throw new Error(
				`Expected logger to be called with message:\n  "${message}"\n\n` +
				`But it was never called with that message. Logged messages:\n  ${loggedMessages.map(m => `"${m}"`).join('\n  ')}`
			);
		}

		// Message found - check metadata
		const actualMetadata = matchingCall[1];
		expect(actualMetadata).toMatchObject(expectedMetadata);
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
			lastFetchedCommitSha: 'commit-initial' as CommitSha
		};

		// Capture console output for debugging failed tests
		const consoleLogCapture: any[] = [];
		const consoleErrorCapture: any[] = [];

		consoleLogSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
			consoleLogCapture.push(['log', args]);
		});
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
			consoleErrorCapture.push(['error', args]);
		});

		// Store captures for afterEach to access
		(global as any).__testConsoleCapture = { log: consoleLogCapture, error: consoleErrorCapture };

		// Spy on fitLogger to verify logging behavior
		fitLoggerLogSpy = jest.spyOn(fitLogger, 'log');
		// Spy on flushToFile but don't mock it - let it run to verify file write attempts
		fitLoggerFlushSpy = jest.spyOn(fitLogger as any, 'flushToFile');
	});

	afterEach(() => {
		// Check if test failed - if so, replay captured console output
		const testState = (expect as any).getState();
		const testFailed = testState.currentTestName && testState.assertionCalls > testState.numPassingAsserts;

		const captures = (global as any).__testConsoleCapture;
		// Restore console first (otherwise console.log won't work)
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		if (testFailed && captures && (captures.log.length > 0 || captures.error.length > 0)) {
			console.log('\n==================== CAPTURED CONSOLE OUTPUT (TEST FAILED) ====================');

			// Replay all captured logs in order
			for (const [, args] of captures.log) {
				console.log('[LOG]', ...args);
			}
			for (const [, args] of captures.error) {
				console.error('[ERROR]', ...args);
			}

			console.log('================================================================================\n');
		}

		// Clean up global
		delete (global as any).__testConsoleCapture;

		// Restore logger spies
		fitLoggerLogSpy.mockRestore();
		fitLoggerFlushSpy.mockRestore();
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
			{ method: 'setMessage', args: ['Checking for changes...'] },
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
		expect(remoteVault.getAllFilesAsRaw()).toEqual({}); // Still empty

		// === STEP 3: Add file B locally (A still exists) ===
		localVault.setFile('fileB.md', 'Content of file B');

		// === STEP 4: Retry sync - SUCCEEDS (no failure set on vaults) ===
		const mockNotice2 = createMockNotice();
		const successResult = await syncAndHandleResult(fitSync, mockNotice2);
		expect(mockNotice2._calls).toEqual([
			{ method: 'setMessage', args: ['Checking for changes...'] },
			{ method: 'setMessage', args: ['Uploading local changes'] },
			{ method: 'setMessage', args: ['Writing remote changes to local'] },
			{ method: 'setMessage', args: ['Sync successful'] }
		]);

		// Verify: Both files A and B were synced (both are new vs baseline)
		expect(successResult).toEqual({
			success: true,
			ops: expect.arrayContaining([
				{
					heading: expect.stringContaining('Remote file updates'),
					ops: expect.arrayContaining([
						expect.objectContaining({ path: 'fileA.md', status: 'created' }),
						expect.objectContaining({ path: 'fileB.md', status: 'created' })
					])
				}
			]),
			clash: []
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
		expect(remoteVault.getAllFilesAsRaw()).toEqual({
			'fileA.md': expect.anything(),
			'fileB.md': expect.anything()
		});
		expect(remoteVault.getCommitSha()).not.toBe('initial-commit');

		// Verify: Logger was called with appropriate tags during sync
		expect(fitLoggerLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('[Fit]'),
			expect.anything()
		);
		expect(fitLoggerLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('[FitSync]'),
			expect.anything()
		);

		// Verify: Console.log was called (fitLogger.log always logs to console)
		expect(consoleLogSpy).toHaveBeenCalled();
	});

	describe('Protected path handling (📁 shouldSyncPath filtering)', () => {
		it('should save remote 📁 .obsidian/ files to _fit/ (both protected and hidden)', async () => {
			// === SETUP: Initial synced state ===
			const fitSync = createFitSync();

			// === STEP 1: Remote has files in .obsidian/ directory ===
			// These are filtered by BOTH shouldSyncPath (protected) and shouldTrackState (hidden)
			await remoteVault.applyChanges([
				{ path: '.obsidian/plugins/plugin1/main.js', content: FileContent.fromPlainText('Plugin code') },
				{ path: '.obsidian/app.json', content: FileContent.fromPlainText('{"theme":"dark"}') },
				{ path: 'normal.md', content: FileContent.fromPlainText('Normal file') }
			], []);

			// === STEP 2: Attempt sync ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeded with protected files treated as clashes
			expect(result).toEqual(expect.objectContaining({ success: true }));
			// Protected/hidden files are now treated as clashes and get appropriate messaging
			expect(mockNotice._calls).toContainEqual({
				method: 'setMessage',
				args: ['Synced with remote, unresolved conflicts written to _fit']
			});

			// Verify: .obsidian/ files saved to _fit/ for safety, normal file pulled directly
			expect(localVault.getAllFilesAsRaw()).toEqual({
				// .obsidian/ files saved to _fit/ (protected path - never write directly to .obsidian/)
				'_fit/.obsidian/app.json': '{"theme":"dark"}',
				'_fit/.obsidian/plugins/plugin1/main.js': 'Plugin code',
				// Normal file pulled directly
				'normal.md': 'Normal file'
			});

			// Verify: LocalStores - .obsidian/ files NOT tracked (filtered by shouldSyncPath)
			// Protected paths (.obsidian/, _fit/) are excluded from both local and remote caches
			expect(localStoreState).toMatchObject({
				localSha: {
					'normal.md': expect.any(String)  // Only normal file
				},
				lastFetchedRemoteSha: {
					'normal.md': expect.any(String)  // Only normal file (protected paths filtered)
				}
			});
		});

		it('should exclude 📁 _fit/ directory from sync operations', async () => {
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
			expect(result1).toEqual(expect.objectContaining({
				success: true,
				ops: expect.arrayContaining([
					{
						heading: expect.stringContaining('Remote file updates'),
						ops: [expect.objectContaining({ path: 'normal.md', status: 'created' })]
					}
				])
			}));

			// Verify: Remote does NOT have _fit/ files
			expect(Object.keys(remoteVault.getAllFilesAsRaw())).toEqual(['normal.md']);

			// === STEP 3: Simulate another device pushing files (including _fit/ edge case) ===
			// Manually add files and trigger commit SHA update by calling applyChanges
			await remoteVault.applyChanges([
				{ path: '_fit/remote-conflict.md', content: FileContent.fromPlainText('Remote _fit file content') },
				{ path: 'remote-normal.md', content: FileContent.fromPlainText('Normal remote file') }
			], []);

			// === STEP 4: Attempt sync - should pull both files, but save _fit/ to _fit/_fit/ ===
			const mockNotice2 = createMockNotice();
			const result2 = await syncAndHandleResult(fitSync, mockNotice2);

			// Verify: Both files pulled, but _fit/ file saved to _fit/_fit/ (protected path treated as clash)
			expect(result2).toEqual({
				success: true,
				ops: expect.arrayContaining([
					{
						heading: expect.stringContaining('Local file updates'),
						ops: expect.arrayContaining([
							expect.objectContaining({ path: '_fit/_fit/remote-conflict.md', status: 'created' }),
							expect.objectContaining({ path: 'remote-normal.md', status: 'created' })
						])
					}
				]),
				clash: [{
					path: '_fit/remote-conflict.md',
					localStatus: 'untracked',
					remoteStatus: 'ADDED'
				}]
			});

			// Verify: Final local vault state
			expect(localVault.getAllFilesAsRaw()).toEqual({
				'_fit/conflict.md': 'Remote version saved locally', // Local-only (created in step 1)
				'_fit/nested/file.md': 'Another conflict',          // Local-only (created in step 1)
				// Remote _fit/ saved to _fit/_fit/ (protected path)
				'_fit/_fit/remote-conflict.md': 'Remote _fit file content',
				'normal.md': 'Normal file content',                 // Synced (created in step 1)
				'remote-normal.md': 'Normal remote file'            // Pulled from remote (step 4)
			});
			// NOT present: '_fit/remote-conflict.md' (would conflict with our conflict resolution area)

			// Verify: LocalStores track different files:
			// - localSha: Only synced files (excludes _fit/ and other protected paths)
			// - lastFetchedRemoteSha: ALL remote files (unfiltered to detect changes correctly)
			expect(Object.keys(localStoreState.localSha).sort()).toEqual(['normal.md', 'remote-normal.md']);
			expect(Object.keys(localStoreState.lastFetchedRemoteSha).sort()).toEqual([
				'_fit/remote-conflict.md',  // Protected path - tracked in remote cache but not local cache
				'normal.md',
				'remote-normal.md'
			]);

			// Verify: Logger was called during sync operations
			expect(fitLoggerLogSpy).toHaveBeenCalledWith(
				expect.stringContaining('[FitSync]'),
				expect.anything()
			);
			expect(consoleLogSpy).toHaveBeenCalled();

			// Verify stat performance: Multiple files with nested paths
			const statLog = localVault.getStatLog();
			// No redundant stats - each path appears at most once
			const uniquePaths = new Set(statLog);
			expect(statLog.length).toBe(uniquePaths.size);
		});
	});

	describe('👻 Hidden file handling', () => {
		it('should not push local hidden file modifications to remote', async () => {
			// === SETUP: Initial synced state ===
			const fitSync = createFitSync();

			// === STEP 1: Create both hidden and normal files locally ===
			localVault.setFile('.hidden-file.md', 'Local hidden content');
			localVault.setFile('visible.md', 'Visible content');

			// === STEP 2: Sync - should only push visible file ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Only visible file was synced (hidden file silently ignored)
			expect(result).toEqual(expect.objectContaining({
				success: true,
				ops: expect.arrayContaining([
					{
						heading: expect.stringContaining('Remote file updates'),
						ops: [expect.objectContaining({ path: 'visible.md', status: 'created' })]
					}
				])
			}));

			// Verify: Remote does NOT have hidden file
			expect(Object.keys(remoteVault.getAllFilesAsRaw())).toEqual(['visible.md']);

			// Verify: LocalStores only track visible file
			expect(Object.keys(localStoreState.localSha)).toEqual(['visible.md']);
			expect(Object.keys(localStoreState.lastFetchedRemoteSha)).toEqual(['visible.md']);

			// === STEP 3: Modify hidden file locally ===
			localVault.setFile('.hidden-file.md', 'Updated hidden content');

			// === STEP 4: Sync again - hidden file modification should be ignored ===
			const mockNotice2 = createMockNotice();
			const result2 = await syncAndHandleResult(fitSync, mockNotice2);

			// Verify: No changes detected (hidden file ignored)
			expect(result2).toEqual(expect.objectContaining({
				success: true,
				ops: [] // No operations
			}));

			// Verify: Remote still only has visible file
			expect(Object.keys(remoteVault.getAllFilesAsRaw())).toEqual(['visible.md']);

			// Verify stat performance: No stats when no remote changes
			expect(localVault.getStatLog()).toEqual([]);
		});

		it('should save remote hidden file to _fit/ when local has different content (⚔️ conflict)', async () => {
			// === SETUP: Initial synced state with normal file ===
			localVault.setFile('normal.md', 'Normal content');
			await remoteVault.setFile('normal.md', 'Normal content');
			const remoteResult = await remoteVault.readFromSource();
			localStoreState = {
				localSha: (await localVault.readFromSource()).state,
				lastFetchedRemoteSha: remoteResult.state,
				lastFetchedCommitSha: remoteResult.commitSha ?? null
			};
			const fitSync = createFitSync();

			// === STEP 1: Create hidden file locally (not tracked by LocalVault) ===
			// This simulates a hidden file that exists on disk but is not indexed by Obsidian
			localVault.setFile('.hidden-config.json', 'Local version');

			// === STEP 2: Another device pushes the same hidden file to remote ===
			await remoteVault.applyChanges([
				{ path: '.hidden-config.json', content: FileContent.fromPlainText('Remote version') }
			], []);

			// === STEP 3: Attempt sync - should succeed and save hidden file clash to _fit/ ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeds with clash detected (hidden file treated as untracked conflict)
			expect(result).toEqual(expect.objectContaining({ success: true }));
			expect(mockNotice._calls).toContainEqual({
				method: 'setMessage',
				args: ['Synced with remote, unresolved conflicts written to _fit']
			});

			// Verify: Local vault wrote as clash
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				// Local hidden file NOT overwritten (kept local version)
				'.hidden-config.json': 'Local version',
				// Remote version saved to _fit/ directory
				'_fit/.hidden-config.json': 'Remote version',
			});

			// Verify: Remote still has the remote version
			expect(remoteVault.getFile('.hidden-config.json')).toBe('Remote version');

			// Verify: LocalStores updated with normal file
			// Hidden file is NOT in localSha (not tracked)
			expect(Object.keys(localStoreState.localSha)).toEqual(['normal.md']);
			// Hidden file IS in lastFetchedRemoteSha (asymmetric behavior)
			expect(Object.keys(localStoreState.lastFetchedRemoteSha).sort()).toEqual(['.hidden-config.json', 'normal.md']);
		});

		it('should conservatively save remote hidden files to _fit/ even when no local version exists', async () => {
			// === SETUP: Initial synced state ===
			const fitSync = createFitSync();

			// === STEP 1: Remote has a hidden file ===
			await remoteVault.applyChanges([
				{
					path: '.hidden-config.json',
					content: FileContent.fromPlainText('Remote hidden content')
				},
				{ path: 'visible.md', content: FileContent.fromPlainText('Visible content') }
			], []);

			// === STEP 2: Attempt sync ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeded
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// Verify: Both files pulled normally (hidden file doesn't exist locally, so safe to write)
			expect(localVault.getAllFilesAsRaw()).toEqual({
				'.hidden-config.json': 'Remote hidden content',
				'visible.md': 'Visible content'
			});

			// Verify: LocalStores has asymmetric tracking (hidden files in remote but not local)
			expect(localStoreState).toMatchObject({
				localSha: {
					'visible.md': expect.any(String)  // Only visible file (hidden filtered by shouldTrackState)
				},
				lastFetchedRemoteSha: {
					'.hidden-config.json': expect.any(String),  // Hidden file tracked (passes shouldSyncPath)
					'visible.md': expect.any(String)            // Visible file tracked
				}
			});
		});
	});

	describe('🚨 Data loss prevention (safety nets for bugs/migrations)', () => {
		it('should never overwrite local file when remote modified but file missing from localSha', async () => {
			// === CRITICAL DATA LOSS SCENARIO ===
			// This simulates TWO dangerous scenarios:
			//
			// SCENARIO 1 (future risk): Future plugin version adds full hidden file tracking via DataAdapter.
			//   - shouldTrackState() returns true for hidden files
			//   - But during version upgrade, localSha doesn't have the file yet (not in baseline)
			//   - Remote has modifications to the hidden file
			//   - Plugin thinks file is tracked but has no SHA to compare against
			//   - Could blindly overwrite local file with remote version → DATA LOSS
			//
			// SCENARIO 2 (current risk): Bug where we misunderstand Obsidian's Vault API contract.
			//   - We think a path type is trackable and call shouldTrackState(path) → true
			//   - But Vault API actually filters/hides it, so it never appears in localSha
			//   - Remote has modifications to the file
			//   - Same result: no SHA to compare, blind overwrite → DATA LOSS
			//
			// PROTECTION REQUIRED: Before overwriting local file, verify it doesn't exist
			// using vault.adapter.exists() (bypasses Vault API filtering, sees ALL files).

			// === SETUP: Simulate state mismatch ===
			// Remote has a hidden file (exists in lastFetchedRemoteSha)
			localStoreState.lastFetchedRemoteSha = {
				'.env': 'fake-sha-for-old-remote-value' as BlobSha
			};
			localStoreState.localSha = {}; // File NOT in localSha (not tracked during scan)

			// Local vault has the file with user modifications (exists on filesystem)
			localVault.setFile('.env', 'API_KEY=local-secret-data');

			// Remote now has a different version
			await remoteVault.applyChanges([
				{ path: '.env', content: FileContent.fromPlainText('API_KEY=new-remote-value') }
			], []);

			// === CRITICAL TEST ===
			// Current behavior: shouldTrackState('.env') → false (filters hidden files)
			// This test simulates: shouldTrackState('.env') → true (future support OR bug)
			//
			// We can't easily override shouldTrackState without modifying production code,
			// but we can verify current protection works, which would also protect the
			// simulated scenarios.
			//
			// The key protection is: FitSync.applyRemoteChanges() checks shouldTrackState()
			// before applying remote changes. If shouldTrackState returns false, it treats
			// as a clash and saves to _fit/ instead of overwriting.

			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeded
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// Verify: remote changes saved to _fit
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				// ✅ CRITICAL: Local file MUST still have user's modifications (not blindly overwritten)
				'.env': 'API_KEY=local-secret-data',
				// ✅ CRITICAL: Remote version should be saved to _fit/ as a clash
				// (Because shouldTrackState filters it, pull logic treats as untracked → clash)
				'_fit/.env': 'API_KEY=new-remote-value'
			});

			// Verify: Remote file unchanged
			expect(remoteVault.getFile('.env')).toBe('API_KEY=new-remote-value');

			// NOTE: Current protection works because shouldTrackState correctly returns false
			// for hidden files, triggering the clash detection logic in FitSync.applyRemoteChanges().
			//
			// However, the DANGEROUS scenarios (future hidden file tracking OR API misunderstanding)
			// where shouldTrackState returns TRUE but file is not in localSha would BYPASS this protection.
			// In those cases, FitSync.applyRemoteChanges() would think the file is trackable,
			// see it's not in localSha, and blindly overwrite local file with remote version.
			//
			// REQUIRED ADDITIONAL PROTECTION:
			// Before applying remote changes in FitSync.applyRemoteChanges():
			//   if (change.status === 'MODIFIED' && !localSha.hasOwnProperty(path)) {
			//     // File modified remotely but not in localSha - could be version migration issue
			//     const exists = await vault.adapter.exists(path);
			//     if (exists) {
			//       fitLogger.log('[FitSync] File exists locally but not in localSha - treating as clash');
			//       // Save to _fit/ instead of overwriting
			//       return false; // Skip overwrite
			//     }
			//   }
			//
			// This test currently verifies the CURRENT protection works. Once ADDITIONAL protection
			// is implemented, this test would also verify it prevents data loss in the dangerous scenarios.
		});

		it('should never delete local file when remote deleted but file missing from localSha', async () => {
			// Scenario: Hidden file exists locally, gets deleted from remote
			// Expected: Local file preserved (not deleted) because we can't verify it's safe to delete
			// This prevents data loss when a file isn't tracked in localSha

			// === SETUP: Initial synced state with hidden file ===
			const hiddenFileContent = 'important local config';
			localVault.setFile('.gitignore', hiddenFileContent);
			localVault.setFile('README.md', 'readme v1');

			remoteVault.setFile('.gitignore', 'remote version');
			remoteVault.setFile('README.md', 'readme v1');

			const { state: initialRemoteState } = await remoteVault.readFromSource();
			const { state: initialLocalState } = await localVault.readFromSource();
			localStoreState = {
				// localSha: .gitignore NOT tracked (hidden file)
				localSha: {
					'README.md': initialLocalState['README.md']
				},
				// lastFetchedRemoteSha: .gitignore IS tracked (asymmetric)
				lastFetchedRemoteSha: {
					'.gitignore': initialRemoteState['.gitignore'],
					'README.md': initialRemoteState['README.md']
				},
				lastFetchedCommitSha: remoteVault.getCommitSha()
			};

			// === STEP 1: Remote deletes .gitignore ===
			await remoteVault.applyChanges(
				[],
				['.gitignore']);

			// === STEP 2: Sync (pull) ===
			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// === VERIFY: Sync succeeded ===
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// === VERIFY: Local .gitignore NOT deleted (safety - can't verify it's safe) ===
			expect(localVault.getAllFilesAsRaw()).toEqual({
				'.gitignore': hiddenFileContent,  // Preserved (untracked, deletion skipped)
				'README.md': 'readme v1'          // Unchanged
			});

			// === VERIFY: Remote state updated ===
			expect(remoteVault.getFile('.gitignore')).toBeUndefined();
		});

		it('should treat remote file as new when missing from lastFetchedRemoteSha cache', async () => {
			// Scenario: File exists on remote but wasn't in lastFetchedRemoteSha due to tracking bug
			// Then a DIFFERENT file changes remotely, triggering a sync
			// The previously-missed file now appears as "newly created" remotely but conflicts with existing local version
			// Expected: Should detect conflict and save remote version to _fit/

			// === SETUP: File exists remotely but not tracked in cache ===
			const localGitignoreContent = 'local-version';
			const remoteGitignoreContent = 'remote-version';

			// Local: .gitignore exists but not tracked
			localVault.setFile('.gitignore', localGitignoreContent);
			localVault.setFile('README.md', 'readme v1');

			// Remote: .gitignore and README.md exist
			remoteVault.setFile('.gitignore', remoteGitignoreContent);
			remoteVault.setFile('README.md', 'readme v1');

			// Simulate state where README.md is tracked but .gitignore is missing from cache
			// This represents old buggy behavior where hidden files weren't indexed
			const { state: initialRemoteState } = await remoteVault.readFromSource();
			const { state: initialLocalState } = await localVault.readFromSource();
			localStoreState = {
				localSha: {
					// README.md IS tracked locally (so it won't appear as "created")
					'README.md': initialLocalState['README.md']
				},
				lastFetchedRemoteSha: {
					// BUG: .gitignore is missing even though it exists in the commit
					'README.md': initialRemoteState['README.md']
					// '.gitignore' is missing from cache
				},
				lastFetchedCommitSha: remoteVault.getCommitSha()
			};

			// === STEP 1: Remote modifies README.md (triggers sync) ===
			// This also causes us to re-scan remote and discover .gitignore
			await remoteVault.applyChanges(
				[{ path: 'README.md', content: FileContent.fromPlainText('readme v2') }],
				[]);

			// === STEP 2: Sync (pull) ===
			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// === VERIFY: Sync succeeded ===
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// === VERIFY: Final local vault state ===
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				// Local .gitignore preserved (conflict - remote ADDED, local exists with different content)
				'.gitignore': localGitignoreContent,
				// README.md updated (was tracked, remote changed, no conflict)
				'README.md': 'readme v2',
				// Remote .gitignore version saved to _fit/ (conflict resolution)
				'_fit/.gitignore': remoteGitignoreContent
			});

			// Verify stat performance: README.md already in localSha (no stat), .gitignore not in localSha (needs stat)
			// Note: .gitignore gets stat checked because it's not in localSha (was missing from cache)
			const statLog = localVault.getStatLog();
			// Should not stat README.md (already tracked in localSha)
			expect(statLog).not.toContain('README.md');
		});

		it('should save remote file to _fit/ when stat fails to check local existence (addition)', async () => {
			// Hidden files aren't in localSha but DO pass shouldSyncPath(), so we stat() them.
			// If stat() fails, conservatively treat file as "may exist" → save to _fit/.

			// === SETUP: Empty initial state ===
			const fitSync = createFitSync();

			// === STEP 1: Remote adds a hidden file ===
			remoteVault.setFile('.envrc', 'export PATH=$PWD/bin:$PATH');

			// === STEP 2: Simulate stat() failing for this path ===
			const statError = new Error('EACCES: permission denied');
			// When stat is called for '.envrc', it should throw an error
			localVault.seedFailureScenario('stat', statError);

			// === STEP 3: Sync (pull) ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// === VERIFY: Sync succeeded (didn't crash on stat error) ===
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// === VERIFY: File saved to _fit/ (conservative fallback) ===
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				// File should be in _fit/ because we couldn't verify it doesn't exist
				'_fit/.envrc': 'export PATH=$PWD/bin:$PATH'
				// .envrc is NOT written directly (could be overwriting existing file)
			});

			// Verify consolidated stat failure logging
			expectLoggerCalledWith(
				'[FitSync] Couldn\'t check if some paths exist locally - conservatively treating as clash',
				{
					error: statError,
					filesMovedToFit: ['.envrc']
				}
			);
		});

		it('should skip deletion when stat fails to check local existence (deletion)', async () => {
			// If stat() fails, deletion is skipped. Main observable difference is in logging
			// (logs consolidated stat failure rather than "already deleted").

			const fitSync = createFitSync();

			// Remote has a hidden file initially
			await remoteVault.setFile('.editorconfig', '# Config\n');
			await syncAndHandleResult(fitSync, createMockNotice());

			// Remote deletes the hidden file
			await remoteVault.applyChanges([], ['.editorconfig']);

			// Simulate stat() failing
			const statError = new Error('EIO: input/output error');
			localVault.seedFailureScenario('stat', statError);

			// Sync (pull)
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify sync succeeded (didn't crash on stat error)
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// Verify deletion was skipped (file still exists from first sync)
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				'.editorconfig': '# Config\n'
			});

			// Verify consolidated stat failure logging
			expectLoggerCalledWith(
				'[FitSync] Couldn\'t check if some paths exist locally - conservatively treating as clash',
				{
					error: statError,
					deletionsSkipped: ['.editorconfig']
				}
			);
		});

		it('must NOT delete remote files when tracking capabilities removed (version migration safety)', async () => {
			// Scenario: Plugin version changes filtering rules (e.g., starts ignoring certain file types)
			// Expected: Deletion NOT pushed to remote (file exists on filesystem but filtered from scan)

			const hiddenFileContent = 'hidden content';
			localVault.setFile('.hidden', hiddenFileContent);
			remoteVault.setFile('.hidden', hiddenFileContent);

			// Simulate v1 tracking the file (before filtering rule change)
			const originalShouldTrackState = localVault.shouldTrackState.bind(localVault);
			localVault.shouldTrackState = () => true; // v1: track all files

			const initialRemoteState = await remoteVault.readFromSource();
			const initialLocalState = await localVault.readFromSource();

			localStoreState = {
				localSha: {
					'.hidden': initialLocalState.state['.hidden']
				},
				lastFetchedRemoteSha: {
					'.hidden': initialRemoteState.state['.hidden']
				},
				lastFetchedCommitSha: remoteVault.getCommitSha()
			};

			// Simulate v2: filtering rule changed (now excludes hidden files)
			localVault.shouldTrackState = originalShouldTrackState;

			// Sync after filtering rule change
			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			expect(result).toEqual(expect.objectContaining({success: true}));

			// File should still exist locally (not deleted)
			expect(localVault.getAllFilesAsRaw()).toMatchObject({'.hidden': hiddenFileContent});

			// File should NOT be deleted from remote (safeguard prevents data loss)
			expect(remoteVault.getFile('.hidden')).toBe(hiddenFileContent);

			// localSha should exclude .hidden (new filtering rules)
			expect(localStoreState.localSha).not.toHaveProperty('.hidden');
		});
	});

	describe('Logger', () => {
		it('should log to console but not write to file when logging is disabled (default)', async () => {
			// Ensure logging is disabled (default state)
			fitLogger.setEnabled(false);

			const fitSync = createFitSync();
			localVault.setFile('test.md', 'content');

			const mockNotice = createMockNotice();
			await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Console.log was called (fitLogger.log always logs to console)
			expect(consoleLogSpy).toHaveBeenCalled();

			// Verify: fitLogger.log was called
			expect(fitLoggerLogSpy).toHaveBeenCalled();

			// Verify: flushToFile was NOT scheduled (logging disabled)
			// Wait a bit to ensure any debounced flush would have been called
			await new Promise(resolve => setTimeout(resolve, 150));
			expect(fitLoggerFlushSpy).not.toHaveBeenCalled();
		});

		it('should write to file when logging is enabled', async () => {
			// Enable logging
			fitLogger.setEnabled(true);
			// Mock vault adapter for file operations
			const mockVault = {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					read: jest.fn().mockResolvedValue(''),
					write: jest.fn().mockResolvedValue(undefined)
				}
			};
			fitLogger.setVault(mockVault as any);
			fitLogger.setPluginDir('.obsidian/plugins/fit');

			const fitSync = createFitSync();
			localVault.setFile('test.md', 'content');

			const mockNotice = createMockNotice();
			await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Console.log was called
			expect(consoleLogSpy).toHaveBeenCalled();

			// Verify: fitLogger.log was called
			expect(fitLoggerLogSpy).toHaveBeenCalled();

			// Verify: flushToFile was called (logging enabled)
			// Wait for debounced flush (100ms + buffer)
			await new Promise(resolve => setTimeout(resolve, 150));
			expect(fitLoggerFlushSpy).toHaveBeenCalled();

			// Verify: vault.adapter.write was called with log file path
			expect(mockVault.adapter.write).toHaveBeenCalledWith(
				'.obsidian/plugins/fit/debug.log',
				expect.stringContaining('[FitSync]')
			);
		});
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
				{ method: 'setMessage', args: ['Checking for changes...'] },
				{ method: 'setMessage', args: [
					"Sync failed: Couldn't reach GitHub API. Please check your internet connection.",
					true
				]}
			]);

			// Verify: Logger was called even during failed sync
			expect(fitLoggerLogSpy).toHaveBeenCalled();
			expect(consoleLogSpy).toHaveBeenCalled();
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
				{ method: 'setMessage', args: ['Checking for changes...'] },
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
				{ method: 'setMessage', args: ['Checking for changes...'] },
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
			localVault.seedFailureScenario('read', fsError);

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify user-friendly error message
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Checking for changes...'] },
				{ method: 'setMessage', args: [
					"Sync failed: File system error: EACCES: permission denied, write 'test.md'",
					true
				]}
			]);
		});
	});
});
