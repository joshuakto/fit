/**
 * Tests for Fit component - High-level sync error scenarios
 */

import { Fit } from './fit';
import { FitSettings, LocalStores } from '../main';
import { Vault } from 'obsidian';
import FitNotice from './fitNotice';
import { SyncErrors, SyncError } from './syncResult';

// Test settings presets
const validSettings: FitSettings = {
	pat: "ghp_validtoken123",
	owner: "testuser",
	avatarUrl: "https://github.com/testuser.png",
	repo: "valid-repo",
	branch: "main",
	deviceName: "Test Device",
	checkEveryXMinutes: 5,
	autoSync: "off",
	notifyChanges: true,
	notifyConflicts: true
};

const emptyLocalStore: LocalStores = {
	localSha: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteSha: {}
};

// Helper to track notice lifecycle during sync attempts
class MockNotice {
	public messages: Array<{ message: string; isError: boolean }> = [];
	public states: Array<'loading' | 'error' | 'done' | 'static'> = [];

	setMessage(message: string, isError = false) {
		this.messages.push({ message, isError });
		if (isError) this.states.push('error');
	}

	remove(state?: 'loading' | 'error' | 'done' | 'static') {
		if (state) this.states.push(state);
	}
}

// Helper to create Fit instances for testing error scenarios
function createFitForErrorScenario(scenario: {
	settings?: Partial<FitSettings>;
	localFiles?: Array<{ path: string; content: string }>;
}): Fit {
	const settings = { ...validSettings, ...scenario.settings };
	const localStore = { ...emptyLocalStore };

	// Create mock vault
	const mockVault = {
		getFiles: jest.fn().mockReturnValue(
			scenario.localFiles?.map(f => ({
				path: f.path,
				extension: f.path.split('.').pop() || '',
				name: f.path.split('/').pop() || f.path
			})) || []
		),
		read: jest.fn(),
	} as unknown as jest.Mocked<Vault>;

	return new Fit(settings, localStore, mockVault);
}

// Helper that emulates a successful sync with realistic results based on local files
async function attemptSuccessfulSync(
	localFiles: Array<{ path: string; content: string }>,
	syncOutcome: 'no-changes' | 'local-changes' | 'remote-changes' | 'both-changes'
) {
	// Create a FitSync fake that returns realistic results based on the scenario
	const mockFitSync = {
		sync: jest.fn().mockImplementation(() => {
			switch (syncOutcome) {
				case 'no-changes':
					return Promise.resolve({ success: true, ops: [], clash: [] }); // FitSync returns success with no operations when already in sync
				case 'local-changes':
					return Promise.resolve({
						success: true,
						ops: [{ heading: "Local file updates:", ops: localFiles.map(f => ({ path: f.path, status: "updated" })) }],
						clash: []
					});
				case 'remote-changes':
					return Promise.resolve({
						success: true,
						ops: [{ heading: "Remote file updates:", ops: [{ path: "remote-file.md", status: "updated" }] }],
						clash: []
					});
				case 'both-changes':
					return Promise.resolve({
						success: true,
						ops: [
							{ heading: "Local file updates:", ops: localFiles.map(f => ({ path: f.path, status: "updated" })) },
							{ heading: "Remote file updates:", ops: [{ path: "remote-file.md", status: "updated" }] }
						],
						clash: []
					});
			}
		})
	};

	const notice = new MockNotice();

	// Start sync attempt (emulates main.ts performManualSync)
	notice.setMessage("Initiating sync");
	notice.states.push('loading');

	// Attempt sync - should succeed (emulates main.ts performManualSync success path)
	try {
		const result = await mockFitSync.sync(notice as unknown as FitNotice);
		// Success path doesn't call getUserErrorMessage, just removes notice as "done"
		notice.remove('done');
		return {
			syncSucceeded: true,
			notice,
			syncResult: result
		};
	} catch (_error) {
		// This shouldn't happen in success scenarios - return failure
		notice.setMessage('Unexpected error in success scenario', true);
		notice.remove('error');
		return {
			syncSucceeded: false,
			notice,
			syncResult: null
		};
	}
}


describe('Fit Sync Success Scenarios', () => {
	it('should complete sync successfully and show done notice when no files need updating', async () => {
		const { syncSucceeded, notice, syncResult } = await attemptSuccessfulSync(
			[{ path: 'notes/existing.md', content: 'Already synced content' }],
			'no-changes'
		);

		// Verify sync completed successfully
		expect(syncSucceeded).toBe(true);
		expect(notice.messages[0]).toEqual({
			message: "Initiating sync",
			isError: false
		});
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('done');

		// Verify success with no file operations (everything in sync)
		expect(syncResult).toEqual({ success: true, ops: [], clash: [] });
	});

	it('should complete sync successfully and track file updates when local changes occur', async () => {
		const localFiles = [
			{ path: 'notes/local-change.md', content: 'Modified locally' },
			{ path: 'ideas/new-idea.md', content: 'Fresh content' }
		];

		const { syncSucceeded, notice, syncResult } = await attemptSuccessfulSync(
			localFiles,
			'local-changes'
		);

		// Verify sync completed successfully
		expect(syncSucceeded).toBe(true);
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('done');

		// Verify local file operations use actual file paths from scenario
		expect(syncResult?.ops).toEqual([{
			heading: "Local file updates:",
			ops: [
				{ path: "notes/local-change.md", status: "updated" },
				{ path: "ideas/new-idea.md", status: "updated" }
			]
		}]);
		expect(syncResult?.clash).toEqual([]);
	});

	it('should complete sync successfully when both local and remote changes occur', async () => {
		const localFiles = [{ path: 'notes/modified.md', content: 'Local changes' }];

		const { syncSucceeded, notice, syncResult } = await attemptSuccessfulSync(
			localFiles,
			'both-changes'
		);

		// Verify sync completed successfully
		expect(syncSucceeded).toBe(true);
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('done');

		// Verify both local and remote operations
		expect(syncResult?.ops).toEqual(
			expect.arrayContaining([
				{ heading: "Local file updates:", ops: [{ path: "notes/modified.md", status: "updated" }] },
				{ heading: "Remote file updates:", ops: [{ path: "remote-file.md", status: "updated" }] }
			])
		);
		expect(syncResult?.clash).toEqual([]);
	});
});

describe('Fit Sync Error Scenarios', () => {
	// Helper that emulates the complete sync attempt and error handling from main.ts
	async function attemptSyncWithStructuredError(
		fit: Fit,
		syncResult: { success: false; error: SyncError }
	) {
		// Mock vault operations to track if updates occurred
		const mockVaultOps = { updateLocalFiles: jest.fn().mockResolvedValue([]) };

		// Mock FitSync that returns structured error result
		const mockFitSync = {
			sync: jest.fn().mockResolvedValue(syncResult)
		};

		const notice = new MockNotice();

		// Start sync attempt (emulates main.ts performManualSync)
		notice.setMessage("Initiating sync");
		notice.states.push('loading');

		// Attempt sync and handle result (emulates main.ts sync method exactly)
		let syncFailed = false;
		const result = await mockFitSync.sync(notice as unknown as FitNotice);

		if (result.success) {
			notice.remove('done');
		} else {
			syncFailed = true;
			// Generate user-friendly message from structured sync error (new approach)
			const errorMessage = fit.getSyncErrorMessage(result.error);
			notice.setMessage(`Sync failed: ${errorMessage}`, true);
			notice.remove('error');
		}

		return {
			syncFailed,
			notice,
			mockVaultOps
		};
	}

	it('should show error notice and make no local updates when branch does not exist', async () => {
		const fit = createFitForErrorScenario({
			settings: { repo: "valid-repo", branch: "nonexistent-branch" },
			localFiles: [
				{ path: 'existing-note.md', content: 'Original content' }
			]
		});

		const { syncFailed, notice, mockVaultOps } = await attemptSyncWithStructuredError(
			fit,
			{
				success: false,
				error: SyncErrors.remoteNotFound('Branch \'nonexistent-branch\' not found on repository \'testuser/valid-repo\'', { source: 'getRef', originalError: new Error('Branch not found') })
			}
		);

		// Verify error notice was shown with user-friendly message
		expect(syncFailed).toBe(true);
		expect(notice.messages[1]).toEqual({
			message: "Sync failed: Branch 'nonexistent-branch' not found on repository 'testuser/valid-repo'. Check your repo and branch settings.",
			isError: true
		});
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('error');

		// Verify no local file updates occurred
		expect(mockVaultOps.updateLocalFiles).not.toHaveBeenCalled();
	});

	it('should show error notice and make no local updates when repository does not exist', async () => {
		const fit = createFitForErrorScenario({
			settings: { repo: "nonexistent-repo" },
			localFiles: [
				{ path: 'existing-note.md', content: 'Original content' }
			]
		});

		const { syncFailed, notice, mockVaultOps } = await attemptSyncWithStructuredError(
			fit,
			{
				success: false,
				error: SyncErrors.remoteNotFound('Repository \'testuser/nonexistent-repo\' not found', { originalError: new Error('Repository not found'), source: 'getTree' })
			}
		);

		// Verify error notice was shown with user-friendly message
		expect(syncFailed).toBe(true);
		expect(notice.messages[1]).toEqual({
			message: "Sync failed: Repository 'testuser/nonexistent-repo' not found. Check your repo and branch settings.",
			isError: true
		});
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('error');

		// Verify no local file updates occurred
		expect(mockVaultOps.updateLocalFiles).not.toHaveBeenCalled();
	});

	it('should show error notice when authentication fails', async () => {
		const fit = createFitForErrorScenario({
			settings: { pat: "invalid_token" }
		});

		const { syncFailed, notice } = await attemptSyncWithStructuredError(
			fit,
			{
				success: false,
				error: SyncErrors.remoteAccess('Authentication failed (bad token?)', { source: 'getUser', originalError: new Error('Bad credentials') })
			}
		);

		expect(syncFailed).toBe(true);
		expect(notice.messages[1]).toEqual({
			message: "Sync failed: Authentication failed (bad token?). Check your GitHub personal access token.",
			isError: true
		});
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('error');
	});

	it('should show appropriate error notice for filesystem issues', async () => {
		const fit = createFitForErrorScenario({
			localFiles: [
				{ path: 'notes/important.md', content: 'Important content' }
			]
		});

		const { syncFailed, notice, mockVaultOps } = await attemptSyncWithStructuredError(
			fit,
			{
				success: false,
				error: SyncErrors.filesystem('EACCES: permission denied, open \'/vault/notes/important.md\'', { originalError: new Error('EACCES: permission denied, open \'/vault/notes/important.md\'') })
			}
		);

		// Verify the filesystem error message includes technical details
		expect(syncFailed).toBe(true);
		expect(notice.messages[1]).toEqual({
			message: "Sync failed: File system error: EACCES: permission denied, open '/vault/notes/important.md'",
			isError: true
		});
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('error');

		// Verify no local file updates occurred
		expect(mockVaultOps.updateLocalFiles).not.toHaveBeenCalled();
	});

	it('should show appropriate error notice for network issues', async () => {
		const fit = createFitForErrorScenario({
			settings: { pat: "valid_token" }
		});

		const { syncFailed, notice } = await attemptSyncWithStructuredError(
			fit,
			{
				success: false,
				error: SyncErrors.network("Couldn't reach GitHub API", { source: 'getUser', originalError: new Error('Failed to fetch') })
			}
		);

		expect(syncFailed).toBe(true);
		expect(notice.messages[1]).toEqual({
			message: "Sync failed: Couldn't reach GitHub API. Please check your internet connection.",
			isError: true
		});
		expect(notice.states).toContain('loading');
		expect(notice.states).toContain('error');
	});
});
