/**
 * Tests to cover behaviors in the FitSync + real Fit components.
 *
 * These cover orchestration behaviors at the FitSync level using the real impl of Fit instead of
 * test doubles, only swapping out lower-level IVault deps to avoid overcomplicating them with
 * non-orchestration details and keep them remote-agnostic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { FitSync } from './fitSync';
import { Fit } from './fit';
import { Vault } from 'obsidian';
import { FakeLocalVault, FakeRemoteVault } from './testUtils';
import { LocalVault } from './localVault';
import { FitSettings, LocalStores } from '@main';
import { VaultError } from './vault';
import { fitLogger } from './logger';
import { FileContent } from './util/contentEncoding';
import { BlobSha, CommitSha } from './util/hashing';
import FitNotice from './fitNotice';

describe('FitSync', () => {
	let localVault: FakeLocalVault;
	let remoteVault: FakeRemoteVault;
	let localStoreState: LocalStores;
	// Spies - MockInstance types inferred from method signatures
	let consoleLogSpy: MockInstance<typeof console.log>;
	let consoleErrorSpy: MockInstance<typeof console.error>;
	let fitLoggerLogSpy: MockInstance<typeof fitLogger.log>;
	let fitLoggerFlushSpy: MockInstance;

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
			setMessage: vi.fn((...args: any[]) => {
				calls.push({ method: 'setMessage', args });
			}),
			remove: vi.fn((...args: any[]) => {
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
			// if (result.changeGroups) {
			//   showUnappliedConflicts(result.changeGroups);
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
		const matchingCall = allCalls.find((call) => call[0] === message);

		if (!matchingCall) {
			// Message not found - show which messages were logged
			const loggedMessages = allCalls.map((call) => call[0]);
			throw new Error(
				`Expected logger to be called with message:\n  "${message}"\n\n` +
				`But it was never called with that message. Logged messages:\n  ${loggedMessages.map((m) => `"${m}"`).join('\n  ')}`
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

		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
			consoleLogCapture.push(['log', args]);
		});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
			consoleErrorCapture.push(['error', args]);
		});

		// Store captures for afterEach to access
		(global as any).__testConsoleCapture = { log: consoleLogCapture, error: consoleErrorCapture };

		// Spy on fitLogger to verify logging behavior
		fitLoggerLogSpy = vi.spyOn(fitLogger, 'log');
		// Spy on flushToFile but don't mock it - let it run to verify file write attempts
		fitLoggerFlushSpy = vi.spyOn(fitLogger as any, 'flushToFile');
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
			changeGroups: expect.arrayContaining([
				{
					heading: expect.stringContaining('Remote file updates'),
					changes: expect.arrayContaining([
						expect.objectContaining({ path: 'fileA.md', type: 'ADDED' }),
						expect.objectContaining({ path: 'fileB.md', type: 'ADDED' })
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
				changeGroups: expect.arrayContaining([
					{
						heading: expect.stringContaining('Remote file updates'),
						changes: [expect.objectContaining({ path: 'normal.md', type: 'ADDED' })]
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
				changeGroups: expect.arrayContaining([
					{
						heading: expect.stringContaining('Local file updates'),
						changes: expect.arrayContaining([
							expect.objectContaining({ path: '_fit/_fit/remote-conflict.md', type: 'ADDED' }),
							expect.objectContaining({ path: 'remote-normal.md', type: 'ADDED' })
						])
					}
				]),
				clash: [{
					path: '_fit/remote-conflict.md',
					localState: 'untracked',
					remoteOp: 'ADDED'
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
				changeGroups: expect.arrayContaining([
					{
						heading: expect.stringContaining('Remote file updates'),
						changes: [expect.objectContaining({ path: 'visible.md', type: 'ADDED' })]
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
				changeGroups: [
					{heading: 'Local file updates:', changes: []},
					{heading: 'Remote file updates:', changes: []}
				]
			}));

			// Verify all notice messages (no file changes, just progress and success)
			expect(mockNotice2._calls).toEqual(expect.arrayContaining([
				{method: 'setMessage', args: ['Uploading local changes']},
				{method: 'setMessage', args: ['Writing remote changes to local']},
				{method: 'setMessage', args: ['Sync successful']}
			]));

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
				lastFetchedCommitSha: remoteResult.commitSha
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

			// Verify: LocalStores updated with both files (issue #169 fix)
			// Hidden file IS now in localSha (SHA keyed by original path, not _fit/ path)
			expect(localStoreState.localSha).toMatchObject({
				'normal.md': expect.any(String),
				'.hidden-config.json': expect.any(String)
			});
			expect(localStoreState.lastFetchedRemoteSha).toMatchObject({
				'normal.md': expect.any(String),
				'.hidden-config.json': expect.any(String)
			});
		});

		it('should update directly after user accepts _fit/ version (#169)', async () => {
			// Test: Clash → User accepts _fit/ version → Next sync updates directly
			//
			// === SETUP: Start from empty state, then create clash ===
			localStoreState = {
				localSha: {},
				lastFetchedRemoteSha: {},
				lastFetchedCommitSha: (await remoteVault.readFromSource()).commitSha
			};

			// Local has hidden file, remote adds same file with different content
			localVault.setFile('.hidden', 'Local content');
			await remoteVault.setFile('.hidden', 'Remote content v1');

			const fitSync = createFitSync();

			// === STEP 1: Sync - clashes to _fit/ and records baseline ===
			await syncAndHandleResult(fitSync, createMockNotice());

			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				'.hidden': 'Local content', // Local version preserved
				'_fit/.hidden': 'Remote content v1' // Remote version saved to _fit/
			});
			expect(localStoreState.localSha['.hidden']).toBeDefined(); // Baseline recorded

			// === STEP 2: User accepts remote version and deletes _fit/ file ===
			localVault.setFile('.hidden', 'Remote content v1');
			await localVault.applyChanges([], ['_fit/.hidden']);

			// === STEP 3: Remote updates file ===
			await remoteVault.setFile('.hidden', 'Remote content v2');

			// === STEP 4: Sync - should update directly (local matches baseline) ===
			await syncAndHandleResult(fitSync, createMockNotice());

			expect(localVault.getAllFilesAsRaw()).toEqual({
				'.hidden': 'Remote content v2', // Updated directly, no new clash
				// Note: No _fit/.hidden file created
			});
		});

		it('should write remote hidden file directly when local unchanged from baseline (#169)', async () => {
			// === SETUP: Initial synced state (no hidden file yet) ===
			const initialContent = 'Initial config v1';
			localVault.setFile('normal.md', 'Normal content');
			await remoteVault.setFile('normal.md', 'Normal content');

			let remoteResult = await remoteVault.readFromSource();
			localStoreState = {
				localSha: await localVault.readFromSource().then(r => r.state),
				lastFetchedRemoteSha: remoteResult.state,
				lastFetchedCommitSha: remoteResult.commitSha
			};
			const fitSync = createFitSync();

			// === STEP 1: Device A creates hidden file and syncs ===
			await remoteVault.setFile('.hidden-config.json', initialContent);

			// === STEP 2: Device B syncs - pulls hidden file ===
			// File doesn't exist locally, so written directly (not a clash)
			let mockNotice = createMockNotice();
			let result = await syncAndHandleResult(fitSync, mockNotice);
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// Verify: File was written directly
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				'.hidden-config.json': initialContent,
				'normal.md': 'Normal content'
			});
			// Baseline SHA now stored for future syncs
			expect(localStoreState.localSha).toHaveProperty('.hidden-config.json');

			// === STEP 3: Device A modifies hidden file and pushes ===
			const updatedContent = 'Updated config v2';
			await remoteVault.setFile('.hidden-config.json', updatedContent);

			// === STEP 4: Device B syncs again - local unchanged from baseline ===
			// Local file still has initial content (unchanged from baseline SHA)
			// Remote file has updated content
			// Expected: Apply remote changes directly (no clash) - this is the #169 fix!
			mockNotice = createMockNotice();
			result = await syncAndHandleResult(fitSync, mockNotice);

			// Verify: Sync succeeds and file was written directly (not to _fit/)
			expect(result).toEqual(expect.objectContaining({ success: true }));
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				'.hidden-config.json': updatedContent,
				'normal.md': 'Normal content'
			});
			// No second clash file created
			expect(localVault.getAllFilesAsRaw()).not.toHaveProperty('_fit/.hidden-config.json');

			// Verify: LocalStores updated with hidden file SHA (now includes hidden files in localSha)
			expect(localStoreState).toMatchObject({
				localSha: {
					'.hidden-config.json': expect.anything(),
				},
				lastFetchedRemoteSha: {
					'.hidden-config.json': expect.anything(),
					'normal.md': expect.anything(),
				},
			});
		});

		it('should write remote hidden files directly when no local version exists (#169)', async () => {
			// Test: Remote adds hidden file → written directly (not to _fit/)
			// Baseline SHA recorded in localSha for future comparison
			//
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

			// === STEP 2: Sync - both files written directly ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			expect(result).toEqual(expect.objectContaining({ success: true }));
			expect(localVault.getAllFilesAsRaw()).toEqual({
				'.hidden-config.json': 'Remote hidden content',  // Written directly (doesn't exist locally)
				'visible.md': 'Visible content'
			});

			// Verify: Baseline SHA recorded for hidden file (#169)
			expect(localStoreState).toMatchObject({
				localSha: {
					'.hidden-config.json': expect.any(String),  // NEW: Baseline recorded for direct write
					'visible.md': expect.any(String)
				},
				lastFetchedRemoteSha: {
					'.hidden-config.json': expect.any(String),
					'visible.md': expect.any(String)
				}
			});
		});
	});

	describe('🚨 Data loss prevention (safety nets for bugs/migrations)', () => {
		it('should never overwrite local file when remote MODIFIED but file missing from localSha', async () => {
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

			// Verify: SHA keyed by original path ".env", NOT "_fit/.env" (issue #169)
			// This enables proper change detection on subsequent syncs
			const expectedSha = await LocalVault.fileSha1('.env', FileContent.fromPlainText('API_KEY=new-remote-value'));
			expect(localStoreState.localSha).toEqual({
				'.env': expectedSha,
				// Must NOT have '_fit/.env'
			});

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
			//   if (change.type === 'MODIFIED' && !localSha.hasOwnProperty(path)) {
			//     // File MODIFIED remotely but not in localSha - could be version migration issue
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
					// README.md IS tracked locally (so it won't appear as "ADDED")
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

			// === VERIFY: File is reported as conflict (not just silently saved) ===
			expect(result).toMatchObject({
				clash: expect.arrayContaining([
					expect.objectContaining({
						path: '.envrc',
						localState: 'untracked',
						remoteOp: 'ADDED'
					})
				])
			});

			// === VERIFY: All notice messages (progress + conflict detection + status) ===
			expect(mockNotice._calls).toEqual([
				{method: 'setMessage', args: ['Checking for changes...']},
				{method: 'setMessage', args: ['Uploading local changes']},
				{method: 'setMessage', args: ['Change conflicts detected']},
				{method: 'setMessage', args: ['Synced with remote, unresolved conflicts written to _fit']}
			]);
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

		it('should report file as conflict when saved to _fit/ for any safety reason', async () => {
			// This test verifies the fix: ANY file written to _fit/ should be reported as a conflict.
			// We use a dual-sided change scenario (both local and remote MODIFIED) which writes to _fit/.

			// === SETUP: Both sides have same file with different content ===
			const fitSync = createFitSync();
			localVault.setFile('document.md', 'Local version\n');
			remoteVault.setFile('document.md', 'Remote version\n');

			// === STEP 1: Initial sync - establishes baseline ===
			await syncAndHandleResult(fitSync, createMockNotice());

			// === STEP 2: Both sides modify the file ===
			localVault.setFile('document.md', 'Local version - edited\n');
			remoteVault.setFile('document.md', 'Remote version - edited\n');

			// === STEP 3: Sync (conflict) ===
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// === VERIFY: Sync succeeded ===
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// === VERIFY: Remote version saved to _fit/ (local file unchanged) ===
			expect(localVault.getAllFilesAsRaw()).toMatchObject({
				'document.md': 'Local version - edited\n',  // Local file untouched
				'_fit/document.md': 'Remote version - edited\n'  // Remote version in conflict directory
			});

			// === VERIFY: File is reported as conflict (this is the key fix!) ===
			expect(result).toMatchObject({
				clash: expect.arrayContaining([
					expect.objectContaining({
						path: 'document.md',
						localState: 'MODIFIED',
						remoteOp: 'MODIFIED'
					})
				])
			});

			// === VERIFY: All notice messages (progress + conflict detection + status) ===
			expect(mockNotice._calls).toEqual([
				{method: 'setMessage', args: ['Checking for changes...']},
				{method: 'setMessage', args: ['Uploading local changes']},
				{method: 'setMessage', args: ['Change conflicts detected']},
				{method: 'setMessage', args: ['Synced with remote, unresolved conflicts written to _fit']}
			]);
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
					exists: vi.fn().mockResolvedValue(false),
					read: vi.fn().mockResolvedValue(null),
					append: vi.fn().mockResolvedValue(undefined),
					rename: vi.fn().mockResolvedValue(undefined)
				}
			};
			fitLogger.configure(mockVault as any, '.obsidian/plugins/fit');

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

			// Verify: vault.adapter.append was called with log file path
			expect(mockVault.adapter.append).toHaveBeenCalledWith(
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

		it('should return already-syncing error when concurrent sync attempted', async () => {
			// Arrange
			const fitSync = createFitSync();
			localVault.setFile('test.md', 'content');
			remoteVault.setFile('test.md', 'content');

			// Create two mock notices for concurrent syncs
			const mockNotice1 = createMockNotice();
			const mockNotice2 = createMockNotice();

			// Act - Start first sync but don't await it yet
			const sync1Promise = fitSync.sync(mockNotice1 as any);

			// Immediately try to start second sync while first is still running
			const sync2Result = await fitSync.sync(mockNotice2 as any);

			// Wait for first sync to complete
			const sync1Result = await sync1Promise;

			// Assert - First sync should succeed
			expect(sync1Result).toEqual(expect.objectContaining({ success: true }));

			// Second sync should fail with already-syncing error
			expect(sync2Result).toEqual({
				success: false,
				error: {
					type: 'already-syncing',
					detailMessage: 'Sync already in progress',
				},
			});

			// Verify notice wasn't updated by second sync (it should return immediately)
			expect(mockNotice2._calls).toEqual([]);
		});
	});

	describe('Per-File Error Handling', () => {
		it('should handle per-file read failures from local vault with detailed error message', async () => {
			// Arrange
			const fitSync = createFitSync();
			localVault.setFile('good-file.md', 'good content');
			localVault.setFile('bad-file.md', 'bad content');
			localVault.setFile('another-bad.md', 'more bad content');

			// Mock writeFile to throw errors for specific files
			localVault.setMockWriteFile(async (path) => {
				if (path === 'bad-file.md') {
					throw new Error('EACCES: permission denied');
				}
				if (path === 'another-bad.md') {
					throw new Error('EIO: input/output error');
				}
			});

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify error message includes failed file paths
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Checking for changes...'] },
				{
					method: 'setMessage', args: [
						expect.stringMatching(/^Sync failed:.*Failed to read 2 file\(s\) from local vault[\s\S]*(bad-file\.md[\s\S]*another-bad\.md|another-bad\.md[\s\S]*bad-file\.md)/),
						true]
				}
			]);
		});

		it('should handle per-file write failures to local vault with detailed error message', async () => {
			// Arrange
			const fitSync = createFitSync();

			// Set up remote files that will need to be written locally
			remoteVault.setFile('good-file.md', 'content 1');
			remoteVault.setFile('readonly-file.md', 'content 2');
			remoteVault.setFile('another-readonly.md', 'content 3');

			// Mock writeFile to throw errors for specific files
			localVault.setMockWriteFile(async (path) => {
				if (path === 'readonly-file.md') {
					throw new Error('EACCES: permission denied');
				}
				if (path === 'another-readonly.md') {
					throw new Error('EROFS: read-only file system');
				}
			});

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify error message shows which file failed to write (both files should be mentioned)
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Checking for changes...'] },
				{ method: 'setMessage', args: ['Uploading local changes'] },
				{ method: 'setMessage', args: ['Writing remote changes to local'] },
				{
					method: 'setMessage', args: [
						expect.stringMatching(/Sync failed:[\s\S]*(readonly-file\.md[\s\S]*another-readonly\.md|another-readonly\.md[\s\S]*readonly-file\.md)/),
						true]
				}
			]);
		});

		it('should handle remote write failures with file path in error message', async () => {
			// Arrange
			const fitSync = createFitSync();

			// Set up local files that will need to be pushed to remote
			localVault.setFile('file-to-push.md', 'local content');

			// Mock remote vault to fail on write
			remoteVault.setFailure(new Error('Failed to process file-to-push.md: API rate limit exceeded'));

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify error message includes the file path context
			// Note: Remote write fails fast before "Uploading local changes" message
			expect(mockNotice._calls).toEqual([
				{ method: 'setMessage', args: ['Checking for changes...'] },
				{
					method: 'setMessage', args: [
						expect.stringMatching(/Sync failed:.*file-to-push\.md/),
						true]
				}
			]);
		});

		it('should show per-file errors with individual error messages in "Failed files:" section', async () => {
			// This test verifies that per-file errors are properly displayed with
			// both the file path and the specific error message for each file.

			// Arrange
			const fitSync = createFitSync();
			localVault.setFile('problematic-file.md', 'local content');

			// Simulate RemoteGitHubVault error pattern: VaultError with errors array
			const fileError = new Error('API error: rate limit exceeded');
			const vaultError = VaultError.network(
				'Failed to process 1 file(s) for remote upload',
				{
					errors: [{ path: 'problematic-file.md', error: fileError }],
					failedPaths: ['problematic-file.md']
				}
			);
			remoteVault.setFailure(vaultError);

			const mockNotice = createMockNotice();

			// Act
			await syncAndHandleResult(fitSync, mockNotice);

			// Assert - Verify the error message has the structured "Failed files:" section
			const errorCall = mockNotice._calls.find(
				(call: any) => call.method === 'setMessage' && call.args[1] === true
			);
			expect(errorCall).toBeDefined();
			const errorMessage = errorCall!.args[0];

			// Should have "Failed files:" section with bullet point and error message
			expect(errorMessage).toMatch(/Failed files:\s+•\s+problematic-file\.md:\s+API error: rate limit exceeded/);
		});
	});

	describe('Only Commit SHA Changed', () => {
		it('should update commit SHA when remote commit changes but no tracked files changed', async () => {
			// Arrange - Set up initial synced state
			const fitSync = createFitSync();
			localVault.setFile('tracked.md', 'content');
			remoteVault.setFile('tracked.md', 'content');

			// Initial sync to establish baseline
			const mockNotice1 = createMockNotice();
			await syncAndHandleResult(fitSync, mockNotice1);
			const initialCommitSha = localStoreState.lastFetchedCommitSha;

			// Act - Simulate external tool pushing commit that doesn't affect our tracked files
			// This simulates a `.gitignore` change or other file we don't track
			// We need to bypass FakeRemoteVault's normal file APIs and directly manipulate the commit SHA
			// to simulate a commit that affects only files we filter out

			// Hack: Directly set a new commit SHA on the fake vault without changing tracked files
			const newCommitSha = ('commit-' + Date.now()) as CommitSha;
			(remoteVault as any).commitSha = newCommitSha;

			// Second sync - should detect commit SHA change even though no file changes
			const mockNotice2 = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice2);

			// Assert
			expect(result).toEqual(expect.objectContaining({success: true}));
			expect(mockNotice2._calls).toEqual([
				{method: 'setMessage', args: ['Checking for changes...']},
				{method: 'setMessage', args: ['Uploading local changes']},
				{method: 'setMessage', args: ['Writing remote changes to local']},
				{method: 'setMessage', args: ['Sync successful']}
			]);

			// Verify commit SHA was updated (this is the key behavior being tested)
			expect(localStoreState.lastFetchedCommitSha).toBe(newCommitSha);
			expect(localStoreState.lastFetchedCommitSha).not.toBe(initialCommitSha);

			// Verify no file operations (truly empty - no changes to tracked files)
			expect(result).toMatchObject({
				changeGroups: [
					{heading: 'Local file updates:', changes: []},
					{heading: 'Remote file updates:', changes: []}
				],
				clash: []
			});
		});
	});

	describe('Concurrent sync coordination (main.ts UI state management)', () => {
		/**
		 * These tests simulate the counter-based coordination logic from main.ts
		 * (onSyncStart/onSyncEnd) to verify correct UI state management under
		 * concurrent sync attempts. This tests the race condition fixes.
		 */

		it('should keep animation active until all manual syncs complete', () => {
			// Simulate the counter-based coordination from main.ts
			const state = {
				activeSyncRequests: 0,
				activeManualSyncRequests: 0,
				animationActive: false,
				noticeCreated: false
			};

			// Helper that mimics onSyncStart/onSyncEnd behavior with manual completion
			const simulateSync = (triggerType: 'manual' | 'auto') => {
				// onSyncStart behavior
				state.activeSyncRequests++;
				if (triggerType === 'manual') {
					state.activeManualSyncRequests++;
					if (state.activeManualSyncRequests === 1) {
						state.animationActive = true;
					}
				}
				if (state.activeSyncRequests === 1) {
					state.noticeCreated = true;
				}

				// Return a function to complete this sync (simulates onSyncEnd)
				return () => {
					state.activeSyncRequests--;
					if (triggerType === 'manual') {
						state.activeManualSyncRequests--;
						if (state.activeManualSyncRequests === 0) {
							state.animationActive = false;
						}
					}
					if (state.activeSyncRequests === 0) {
						state.noticeCreated = false;
					}
				};
			};

			// Race condition scenario from user's bug report:
			// - Sync 1 starts (manual, long-running)
			// - Sync 2 attempted (manual, gets already-syncing)
			// - Sync 3 attempted (manual, gets already-syncing)
			// - Animation should persist until Sync 1 finishes
			const completeSync1 = simulateSync('manual');
			const completeSync2 = simulateSync('manual');
			const completeSync3 = simulateSync('manual');

			// After starting all syncs, verify state
			expect(state).toEqual({
				activeSyncRequests: 3,
				activeManualSyncRequests: 3,
				animationActive: true,
				noticeCreated: true,
			});

			// Complete quick syncs (would have gotten already-syncing in real scenario)
			completeSync2();
			completeSync3();

			// After quick syncs finish, animation should STILL be active
			expect(state).toMatchObject({
				activeManualSyncRequests: 1, // Still one active
				animationActive: true, // ✅ Bug would have cleared this early
				noticeCreated: true, // Notice still active
			});

			// After long sync finishes, animation should clear
			completeSync1();
			expect(state).toMatchObject({
				activeManualSyncRequests: 0,
				animationActive: false,
				noticeCreated: false,
			});
		});

		it('should keep manual animation active during auto-sync', () => {
			// Verify separate counters for manual vs auto
			const state = {
				activeSyncRequests: 0,
				activeManualSyncRequests: 0,
				animationActive: false,
			};

			const simulateSync = (triggerType: 'manual' | 'auto') => {
				// onSyncStart
				state.activeSyncRequests++;
				if (triggerType === 'manual') {
					state.activeManualSyncRequests++;
					if (state.activeManualSyncRequests === 1) {
						state.animationActive = true;
					}
				}

				// Return completion function
				return () => {
					state.activeSyncRequests--;
					if (triggerType === 'manual') {
						state.activeManualSyncRequests--;
						if (state.activeManualSyncRequests === 0) {
							state.animationActive = false;
						}
					}
				};
			};

			// Scenario: Auto-sync starts, then manual sync during it
			const completeAutoSync = simulateSync('auto');
			const completeManualSync = simulateSync('manual');

			// Manual sync should show animation
			expect(state).toMatchObject({
				animationActive: true,
				activeSyncRequests: 2,
			});

			// After manual completes, animation should clear even though auto still running
			completeManualSync();
			expect(state).toMatchObject({
				animationActive: false,
				activeSyncRequests: 1, // Auto still running
			});

			completeAutoSync();
			expect(state.activeSyncRequests).toBe(0);
		});

		it('should create only one notice for concurrent requests', () => {
			// Verify single shared notice for all concurrent syncs
			const state = {
				activeSyncRequests: 0,
				noticeCount: 0,
			};

			const simulateSync = () => {
				// onSyncStart
				state.activeSyncRequests++;
				if (state.activeSyncRequests === 1) {
					state.noticeCount++; // Only first request creates notice
				}

				// Return completion function
				return () => {
					state.activeSyncRequests--;
					if (state.activeSyncRequests === 0) {
						state.noticeCount--; // Last request cleans up notice
					}
				};
			};

			// Start multiple concurrent syncs
			const completeSync1 = simulateSync();
			const completeSync2 = simulateSync();
			const completeSync3 = simulateSync();

			// During concurrent execution, should only have one notice
			expect(state).toMatchObject({
				noticeCount: 1,
				activeSyncRequests: 3,
			});

			// Complete some syncs
			completeSync2();
			completeSync3();
			expect(state).toMatchObject({
				noticeCount: 1, // Still just one notice
				activeSyncRequests: 1,
			});

			// Complete last sync
			completeSync1();
			expect(state).toMatchObject({
				noticeCount: 0, // Cleaned up after last completes
				activeSyncRequests: 0,
			});
		});
	});

	describe('🔤 Encoding corruption detection (Issue #51)', () => {
		it('should create FitNotice when localVault.applyChanges returns userWarning', async () => {
			// Test that FitSync properly handles userWarning from vault operations
			// Actual detection logic is tested in localVault.test.ts

			// Mock FitNotice to avoid DOM dependencies
			const fitNoticeSpy = vi.spyOn(FitNotice.prototype, 'show').mockImplementation(() => {});

			// Mock localVault.applyChanges to return a userWarning
			const mockApplyChanges = vi.spyOn(localVault, 'applyChanges').mockResolvedValue({
				changes: [{ path: 'test.md', type: 'ADDED' }],
				newBaselineStates: Promise.resolve({ 'test.md': 'mock-sha' as BlobSha }),
				userWarning: '⚠️ Encoding Issue Detected\nSuspicious filename patterns found during sync.'
			});

			// Setup a simple sync scenario
			remoteVault.setFile('test.md', 'content');
			localStoreState = {
				localSha: {},
				lastFetchedRemoteSha: {},
				lastFetchedCommitSha: remoteVault.getCommitSha()
			};

			const fitSync = createFitSync();
			const mockNotice = createMockNotice();
			const result = await syncAndHandleResult(fitSync, mockNotice);

			// Sync should succeed (warnings are informational, not errors)
			expect(result).toEqual(expect.objectContaining({ success: true }));

			// Verify FitNotice.show() was called (warning notice was created and shown)
			expect(fitNoticeSpy).toHaveBeenCalled();

			mockApplyChanges.mockRestore();
			fitNoticeSpy.mockRestore();
		});
	});
});
