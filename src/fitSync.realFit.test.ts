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
import { fitLogger } from './logger';

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

		// Suppress console noise during tests
		consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		// Spy on fitLogger to verify logging behavior
		fitLoggerLogSpy = jest.spyOn(fitLogger, 'log');
		// Spy on flushToFile but don't mock it - let it run to verify file write attempts
		fitLoggerFlushSpy = jest.spyOn(fitLogger as any, 'flushToFile');
	});

	afterEach(() => {
		// Restore console and logger
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
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
			{ path: '_fit/remote-conflict.md', content: 'Remote _fit file content' },
			{ path: 'remote-normal.md', content: 'Normal remote file' }
		], []);

		// === STEP 4: Attempt sync - should pull both files, but save _fit/ to _fit/_fit/ ===
		const mockNotice2 = createMockNotice();
		const result2 = await syncAndHandleResult(fitSync, mockNotice2);

		// Verify: Both files pulled, but _fit/ file saved to _fit/_fit/ (protected path treated as clash)
		expect(result2).toMatchObject({
			success: true,
			ops: expect.arrayContaining([
				{
					heading: expect.stringContaining('Local file updates'),
					ops: expect.arrayContaining([
						expect.objectContaining({ path: '_fit/_fit/remote-conflict.md', status: 'created' }),
						expect.objectContaining({ path: 'remote-normal.md', status: 'created' })
					])
				}
			])
		});

		// Verify: Final local vault state
		expect(Object.fromEntries((localVault as any).files)).toEqual({
			'_fit/conflict.md': 'Remote version saved locally',         // Local-only (created in step 1)
			'_fit/nested/file.md': 'Another conflict',                  // Local-only (created in step 1)
			'_fit/_fit/remote-conflict.md': 'Remote _fit file content', // Remote _fit/ saved to _fit/_fit/ (protected path)
			'normal.md': 'Normal file content',                         // Synced (created in step 1)
			'remote-normal.md': 'Normal remote file'                    // Pulled from remote (step 4)
		});
		// NOT present: '_fit/remote-conflict.md' (would conflict with our conflict resolution area)

		// Verify: LocalStores only track synced files (no _fit/ paths)
		expect(Object.keys(localStoreState.localSha).sort()).toEqual(['normal.md', 'remote-normal.md']);
		expect(Object.keys(localStoreState.lastFetchedRemoteSha).sort()).toEqual(['normal.md', 'remote-normal.md']);

		// Verify: Logger was called during sync operations
		expect(fitLoggerLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('[FitSync]'),
			expect.anything()
		);
		expect(consoleLogSpy).toHaveBeenCalled();
	});

	describe('Hidden file handling (💾 shouldTrackState filtering)', () => {
		it('should silently ignore local hidden file changes (not synced to remote)', async () => {
			// === SETUP: Initial synced state ===
			const fitSync = createFitSync();

			// === STEP 1: Create both hidden and normal files locally ===
			localVault.setFile('.hidden-file.md', 'Local hidden content');
			localVault.setFile('visible.md', 'Visible content');

			// === STEP 2: Sync - should only push visible file ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Only visible file was synced (hidden file silently ignored)
			expect(result).toMatchObject({
				success: true,
				ops: expect.arrayContaining([
					{
						heading: expect.stringContaining('Remote file updates'),
						ops: [expect.objectContaining({ path: 'visible.md', status: 'created' })]
					}
				])
			});

			// Verify: Remote does NOT have hidden file
			expect(remoteVault.getAllPaths()).toEqual(['visible.md']);

			// Verify: LocalStores only track visible file
			expect(Object.keys(localStoreState.localSha)).toEqual(['visible.md']);
			expect(Object.keys(localStoreState.lastFetchedRemoteSha)).toEqual(['visible.md']);

			// === STEP 3: Modify hidden file locally ===
			localVault.setFile('.hidden-file.md', 'Updated hidden content');

			// === STEP 4: Sync again - hidden file modification should be ignored ===
			const mockNotice2 = createMockNotice();
			const result2 = await syncAndHandleResult(fitSync, mockNotice2);

			// Verify: No changes detected (hidden file ignored)
			expect(result2).toMatchObject({
				success: true,
				ops: [] // No operations
			});

			// Verify: Remote still only has visible file
			expect(remoteVault.getAllPaths()).toEqual(['visible.md']);
		});

		it('should save conflicting remote hidden file to _fit/ directory', async () => {
			// === SETUP: Initial synced state with normal file ===
			localVault.setFile('normal.md', 'Normal content');
			await remoteVault.setFile('normal.md', 'Normal content');
			localStoreState = {
				localSha: await localVault.readFromSource(),
				lastFetchedRemoteSha: await remoteVault.readFromSource(),
				lastFetchedCommitSha: remoteVault.getCommitSha()
			};
			const fitSync = createFitSync();

			// === STEP 1: Create hidden file locally (not tracked by LocalVault) ===
			// This simulates a hidden file that exists on disk but is not indexed by Obsidian
			localVault.setFile('.hidden-config.json', 'Local version');

			// === STEP 2: Another device pushes the same hidden file to remote ===
			await remoteVault.applyChanges([
				{ path: '.hidden-config.json', content: 'Remote version' }
			], []);

			// === STEP 3: Attempt sync - should succeed and save hidden file clash to _fit/ ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeds with clash detected (hidden file treated as untracked conflict)
			expect(result).toMatchObject({
				success: true
			});
			expect(mockNotice._calls).toContainEqual({
				method: 'setMessage',
				args: ['Synced with remote, unresolved conflicts written to _fit']
			});

			// Verify: Local hidden file NOT overwritten (kept local version)
			expect(localVault.getFile('.hidden-config.json')).toBe('Local version');

			// Verify: Remote version saved to _fit/ directory
			expect(localVault.getFile('_fit/.hidden-config.json')).toBe('Remote version');

			// Verify: Remote still has the remote version
			expect(remoteVault.getFile('.hidden-config.json')).toBe('Remote version');

			// Verify: LocalStores updated with normal file
			// Hidden file is NOT in localSha (not tracked)
			expect(Object.keys(localStoreState.localSha)).toEqual(['normal.md']);
			// Hidden file IS in lastFetchedRemoteSha (asymmetric behavior)
			expect(Object.keys(localStoreState.lastFetchedRemoteSha).sort()).toEqual(['.hidden-config.json', 'normal.md']);
		});

		it('should conservatively save remote hidden files to _fit/', async () => {
			// === SETUP: Initial synced state ===
			const fitSync = createFitSync();

			// === STEP 1: Remote has a hidden file ===
			await remoteVault.applyChanges([
				{ path: '.hidden-config.json', content: 'Remote hidden content' },
				{ path: 'visible.md', content: 'Visible content' }
			], []);

			// === STEP 2: Attempt sync ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeded
			expect(result).toMatchObject({
				success: true
			});

			// Verify: Visible file pulled normally, hidden file saved to _fit/ for safety
			// SAFETY: We can't verify hidden file doesn't exist locally (not tracked in localSha)
			// so we conservatively save to _fit/ to avoid data loss
			expect(Object.fromEntries((localVault as any).files)).toEqual({
				// Hidden file saved to _fit/ (conservative - can't verify no local changes)
				'_fit/.hidden-config.json': 'Remote hidden content',
				// Normal file pulled directly
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

	describe('Protected path handling (📁 shouldSyncPath filtering)', () => {
		it('should save remote 📁 .obsidian/ files to _fit/ (both protected and hidden)', async () => {
			// === SETUP: Initial synced state ===
			const fitSync = createFitSync();

			// === STEP 1: Remote has files in .obsidian/ directory ===
			// These are filtered by BOTH shouldSyncPath (protected) and shouldTrackState (hidden)
			await remoteVault.applyChanges([
				{ path: '.obsidian/plugins/plugin1/main.js', content: 'Plugin code' },
				{ path: '.obsidian/app.json', content: '{"theme":"dark"}' },
				{ path: 'normal.md', content: 'Normal file' }
			], []);

			// === STEP 2: Attempt sync ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeded with protected files treated as clashes
			expect(result).toMatchObject({
				success: true
			});
			// Protected/hidden files are now treated as clashes and get appropriate messaging
			expect(mockNotice._calls).toContainEqual({
				method: 'setMessage',
				args: ['Synced with remote, unresolved conflicts written to _fit']
			});

			// Verify: .obsidian/ files saved to _fit/ for safety, normal file pulled directly
			expect(Object.fromEntries((localVault as any).files)).toEqual({
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
	});

	describe('🔒 Data integrity', () => {
		it('must detect clash conservatively for local files missing from cache', async () => {
			// Scenario: Remote modifies .gitignore, which exists locally but wasn't tracked (hidden file)
			// Expected: Should detect conflict and save remote version to _fit/.gitignore instead of overwriting

			// === SETUP: .gitignore exists locally but not in tracking caches ===
			const localGitignoreContent = 'local-only-ignore-rule';
			const remoteGitignoreOld = 'remote-old-ignore-rule';
			const remoteGitignoreNew = 'remote-new-ignore-rule';

			// Local: .gitignore exists but won't be tracked (hidden file)
			localVault.setFile('.gitignore', localGitignoreContent);

			// Remote: .gitignore exists with old content
			remoteVault.setFile('.gitignore', remoteGitignoreOld);

			// Simulate state where .gitignore was never tracked locally (cache is empty)
			// This represents the old buggy behavior where hidden files weren't indexed
			const initialRemoteState = await remoteVault.readFromSource();
			localStoreState = {
				localSha: {},  // Empty - .gitignore never tracked locally
				lastFetchedRemoteSha: {
					'.gitignore': initialRemoteState['.gitignore'],
				},
				lastFetchedCommitSha: remoteVault.getCommitSha()
			};

			// === STEP 1: Remote modifies .gitignore ===
			await remoteVault.applyChanges([{path: '.gitignore', content: remoteGitignoreNew}], []);

			// === STEP 2: Sync (pull) ===
			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// === VERIFY: Sync succeeded ===
			expect(result).toMatchObject({
				success: true
			});

			// === VERIFY: Final local vault state ===
			expect(Object.fromEntries((localVault as any).files)).toEqual({
				// Local .gitignore preserved (conflict - different content)
				'.gitignore': localGitignoreContent,
				// Remote .gitignore version saved to _fit/ (conflict resolution)
				'_fit/.gitignore': remoteGitignoreNew
			});
		});

		it('must handle newly tracked remote file safely', async () => {
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
			const initialRemoteState = await remoteVault.readFromSource();
			const initialLocalState = await localVault.readFromSource();
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
			await remoteVault.applyChanges([{path: 'README.md', content: 'readme v2'}], []);

			// === STEP 2: Sync (pull) ===
			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// === VERIFY: Sync succeeded ===
			expect(result).toMatchObject({
				success: true
			});

			// === VERIFY: Final local vault state ===
			expect(Object.fromEntries((localVault as any).files)).toMatchObject({
				// Local .gitignore preserved (conflict - remote ADDED, local exists with different content)
				'.gitignore': localGitignoreContent,
				// README.md updated (was tracked, remote changed, no conflict)
				'README.md': 'readme v2',
				// Remote .gitignore version saved to _fit/ (conflict resolution)
				'_fit/.gitignore': remoteGitignoreContent
			});
		});

		it('must never delete untracked local files', async () => {
			// Scenario: Hidden file exists locally, gets deleted from remote
			// Expected: Local file preserved (not deleted) because we can't verify it's safe to delete
			// This prevents data loss when a file isn't tracked in localSha

			// === SETUP: Initial synced state with hidden file ===
			const hiddenFileContent = 'important local config';
			localVault.setFile('.gitignore', hiddenFileContent);
			localVault.setFile('README.md', 'readme v1');

			remoteVault.setFile('.gitignore', 'remote version');
			remoteVault.setFile('README.md', 'readme v1');

			const initialRemoteState = await remoteVault.readFromSource();
			const initialLocalState = await localVault.readFromSource();
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

			// === STEP 1: Remote DELETES .gitignore ===
			await remoteVault.applyChanges([], ['.gitignore']);

			// === STEP 2: Sync (pull) ===
			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// === VERIFY: Sync succeeded ===
			expect(result).toMatchObject({
				success: true
			});

			// === VERIFY: Local .gitignore NOT deleted (safety - can't verify it's safe) ===
			expect(Object.fromEntries((localVault as any).files)).toEqual({
				'.gitignore': hiddenFileContent,  // Preserved (untracked, deletion skipped)
				'README.md': 'readme v1'          // Unchanged
			});

			// === VERIFY: Remote state updated ===
			expect(remoteVault.getFile('.gitignore')).toBeUndefined();
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
				{ method: 'setMessage', args: ['Performing pre sync checks.'] },
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
