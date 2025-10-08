import { FitSync } from './fitSync';
import { Fit, OctokitHttpError } from './fit';
import FitNotice from './fitNotice';
import { LocalStores } from '../main';
import { LocalChange, RemoteChange, FileOpRecord, LocalFileStatus, RemoteChangeType } from './fitTypes';

// Simple test doubles focused on behavior
describe('FitSync', () => {
	let fitSync: FitSync;
	let saveLocalStoreCallback: jest.MockedFunction<(localStore: Partial<LocalStores>) => Promise<void>>;

	// Helper to create a FitSync with configured behavior
	function createFitSync(scenario: {
		localChanges?: LocalChange[];
		remoteUpdated?: boolean;
		remoteCommitSha?: string;
		remoteChanges?: RemoteChange[];
		remoteTreeSha?: Record<string, string>;
		localSha?: Record<string, string>;
		clashes?: Array<{path: string, localStatus: LocalFileStatus, remoteStatus: RemoteChangeType}>;
	}) {
		const mockFit = {
			computeLocalSha: jest.fn().mockResolvedValue(scenario.localSha || { 'file1.txt': 'sha1' }),
			getLocalChanges: jest.fn().mockResolvedValue(scenario.localChanges || []),
			remoteUpdated: jest.fn().mockResolvedValue({
				remoteCommitSha: scenario.remoteCommitSha || 'commit123',
				updated: scenario.remoteUpdated || false
			}),
			getRemoteTreeSha: jest.fn().mockResolvedValue(scenario.remoteTreeSha || {}),
			getRemoteChanges: jest.fn().mockResolvedValue(scenario.remoteChanges || []),
			getClashedChanges: jest.fn().mockReturnValue(scenario.clashes || []),
			localVault: {
				applyChanges: jest.fn().mockResolvedValue([{ path: 'file.txt', status: 'created' as const }] as FileOpRecord[]),
			},
		} as unknown as Fit;

		return new FitSync(mockFit, saveLocalStoreCallback);
	}

	beforeEach(() => {
		saveLocalStoreCallback = jest.fn().mockResolvedValue(undefined);
	});

	describe('sync', () => {
		it('should complete successfully when files are already in sync', async () => {
			// Arrange
			fitSync = createFitSync({ localChanges: [], remoteUpdated: false });
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({ success: true, ops: [], clash: [] });
		});

		it('should update commit SHA when only remote commit changed', async () => {
			// Arrange
			const newCommitSha = 'newCommit456';
			fitSync = createFitSync({
				localChanges: [],
				remoteUpdated: true,
				remoteCommitSha: newCommitSha,
				remoteChanges: []
			});
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({ success: true, ops: [], clash: [] });
			expect(saveLocalStoreCallback).toHaveBeenCalledWith({
				lastFetchedCommitSha: newCommitSha
			});
		});

		it('should handle local changes scenario', async () => {
			// Arrange
			const localChanges = [{ path: 'file1.txt', status: 'changed' as const }];
			fitSync = createFitSync({ localChanges, remoteUpdated: false });
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Mock the push behavior
			fitSync.fitPush.pushChangedFilesToRemote = jest.fn().mockResolvedValue({
				pushedChanges: localChanges,
				lastFetchedRemoteSha: { 'file1.txt': 'newSha1' },
				lastFetchedCommitSha: 'newCommit789'
			});

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({
				success: true,
				ops: [{ heading: 'Local file updates:', ops: localChanges }],
				clash: []
			});
		});

		it('should handle remote changes scenario', async () => {
			// Arrange
			const remoteChanges = [{ path: 'file2.txt', status: 'ADDED' as const }];
			fitSync = createFitSync({
				localChanges: [],
				remoteUpdated: true,
				remoteCommitSha: 'commit456',
				remoteChanges,
				remoteTreeSha: { 'file1.txt': 'sha1', 'file2.txt': 'sha2' }
			});
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Mock the pull behavior
			const mockFileOps = [{ path: 'file2.txt', status: 'created' as const }];
			fitSync.fitPull.pullRemoteToLocal = jest.fn().mockResolvedValue(mockFileOps);

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({
				success: true,
				ops: [{ heading: 'Local file updates:', ops: mockFileOps }],
				clash: []
			});
		});

		it('should handle compatible local and remote changes', async () => {
			// Arrange
			const localChanges = [{ path: 'file1.txt', status: 'changed' as const }];
			const remoteChanges = [{ path: 'file2.txt', status: 'ADDED' as const }];
			fitSync = createFitSync({
				localChanges,
				remoteUpdated: true,
				remoteCommitSha: 'commit456',
				remoteChanges,
				remoteTreeSha: { 'file1.txt': 'sha1', 'file2.txt': 'sha2' }
			});
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Mock the compatible changes behavior
			const mockLocalOps = [{ path: 'file2.txt', status: 'created' as const }];
			const mockRemoteOps = [{ path: 'file1.txt', status: 'changed' as const }];

			fitSync.syncCompatibleChanges = jest.fn().mockResolvedValue({
				localOps: mockLocalOps,
				remoteOps: mockRemoteOps
			});

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({
				success: true,
				ops: [
					{ heading: 'Local file updates:', ops: mockLocalOps },
					{ heading: 'Remote file updates:', ops: mockRemoteOps }
				],
				clash: []
			});
		});

		it('should handle conflicts and create _fit directory for unresolved files', async () => {
			// Arrange
			const localChanges = [{ path: 'shared.txt', status: 'changed' as const }];
			const remoteChanges = [{ path: 'shared.txt', status: 'MODIFIED' as const }];
			const clashedFiles = [{ path: 'shared.txt', localStatus: 'changed' as const, remoteStatus: 'MODIFIED' as const }];

			fitSync = createFitSync({
				localChanges,
				remoteUpdated: true,
				remoteCommitSha: 'commit456',
				remoteChanges,
				remoteTreeSha: { 'shared.txt': 'remotesha' }
			});

			// Override getClashedChanges to return conflicts
			fitSync.fit.getClashedChanges = jest.fn().mockReturnValue(clashedFiles);

			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Mock conflict resolution that creates files in _fit directory
			const conflictFileOps = [{ path: '_fit/shared.txt', status: 'created' as const }];
			fitSync.syncWithConflicts = jest.fn().mockResolvedValue({
				unresolvedFiles: clashedFiles,
				localOps: conflictFileOps,
				remoteOps: []
			});

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({
				success: true,
				ops: [
					{ heading: 'Local file updates:', ops: conflictFileOps },
					{ heading: 'Remote file updates:', ops: [] }
				],
				clash: clashedFiles
			});
		});

		it('should handle notice lifecycle correctly', async () => {
			// Arrange
			fitSync = createFitSync({ localChanges: [], remoteUpdated: false });
			const mockNotice = {
				setMessage: jest.fn(),
				remove: jest.fn(),
				mute: jest.fn(),
				hide: jest.fn()
			};
			const notice = mockNotice as unknown as FitNotice;

			// Act
			await fitSync.sync(notice);

			// Assert - verify notice was used for communication but no hiding called directly
			expect(mockNotice.setMessage).toHaveBeenCalled();
			expect(mockNotice.hide).not.toHaveBeenCalled(); // FitSync doesn't directly hide notices
			expect(mockNotice.mute).not.toHaveBeenCalled(); // FitSync doesn't mute notices
		});

		// Sync orchestration and error classification tests
		describe('sync orchestration logic', () => {
			it('should correctly classify generic errors as unknown', async () => {
				// Arrange - Mock a generic failure during pre-sync checks
				const genericError = new Error('fetch failed');
				const mockFit = {
					computeLocalSha: jest.fn().mockRejectedValue(genericError),
					getLocalChanges: jest.fn(),
					remoteUpdated: jest.fn(),
					getRemoteTreeSha: jest.fn(),
					getRemoteChanges: jest.fn(),
					getClashedChanges: jest.fn(),
				} as unknown as Fit;

				fitSync = new FitSync(mockFit, saveLocalStoreCallback);
				const notice = { setMessage: jest.fn() } as unknown as FitNotice;

				// Act
				const result = await fitSync.sync(notice);

				// Assert - Verify error classification and technical details
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toEqual({
						type: 'unknown',
						detailMessage: 'Error: fetch failed',
						details: {
							originalError: genericError
						}
					});
				}
			});

			it('should correctly classify authentication errors with technical details', async () => {
				// Arrange - Mock GitHub API 401 error
				const githubError = new OctokitHttpError('Bad credentials', 401, 'getUser');
				const mockFit = {
					computeLocalSha: jest.fn().mockRejectedValue(githubError),
					getLocalChanges: jest.fn(),
					remoteUpdated: jest.fn(),
					getRemoteTreeSha: jest.fn(),
					getRemoteChanges: jest.fn(),
					getClashedChanges: jest.fn(),
				} as unknown as Fit;

				fitSync = new FitSync(mockFit, saveLocalStoreCallback);
				const notice = { setMessage: jest.fn() } as unknown as FitNotice;

				// Act
				const result = await fitSync.sync(notice);

				// Assert - Verify error classification with GitHub-specific details
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toEqual({
						type: 'remote_access',
						detailMessage: 'Authentication failed (bad token?)',
						details: {
							source: 'getUser',
							originalError: githubError
						}
					});
				}
			});

			it.each([
				{
					scenario: 'branch not found (repo exists)',
					checkRepoExistsMock: jest.fn().mockResolvedValue(true), // checkRepoExists returns true
					expectedMessage: 'Branch \'main\' not found on repository \'testuser/testrepo\''
				},
				{
					scenario: 'repository not found',
					checkRepoExistsMock: jest.fn().mockResolvedValue(false), // checkRepoExists returns false
					expectedMessage: 'Repository \'testuser/testrepo\' not found'
				},
				{
					scenario: 'repository access denied during check',
					checkRepoExistsMock: jest.fn().mockRejectedValue(new OctokitHttpError('Forbidden', 403, 'checkRepoExists')), // checkRepoExists throws
					expectedMessage: 'Repository \'testuser/testrepo\' or branch \'main\' not found'
				}
			])('should correctly classify remote not found errors: $scenario', async ({ checkRepoExistsMock, expectedMessage }) => {
				// Arrange - Mock GitHub API 404 error from getRef operation
				const githubError = new OctokitHttpError('Not Found - https://docs.github.com/rest/git/refs#get-a-reference', 404, 'getRef');
				const mockFit = {
					owner: 'testuser',
					repo: 'testrepo',
					branch: 'main',
					remoteVault: {
						getOwner: () => 'testuser',
						getRepo: () => 'testrepo',
						getBranch: () => 'main',
					},
					computeLocalSha: jest.fn().mockRejectedValue(githubError),
					getLocalChanges: jest.fn(),
					remoteUpdated: jest.fn(),
					getRemoteTreeSha: jest.fn(),
					getRemoteChanges: jest.fn(),
					getClashedChanges: jest.fn(),
					checkRepoExists: checkRepoExistsMock,
				} as unknown as Fit;

				fitSync = new FitSync(mockFit, saveLocalStoreCallback);
				const notice = { setMessage: jest.fn() } as unknown as FitNotice;

				// Act
				const result = await fitSync.sync(notice);

				// Assert - Verify operation-specific error classification
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toEqual({
						type: 'remote_not_found',
						detailMessage: expectedMessage,
						details: {
							source: 'getRef',
							originalError: githubError
						}
					});
				}
			});

			it('should classify 403 access denied as remote access error', async () => {
				// Arrange - Mock GitHub API 403 permissions error
				const accessDeniedError = new OctokitHttpError('Insufficient permissions', 403, 'getUser');
				const mockFit = {
					computeLocalSha: jest.fn().mockRejectedValue(accessDeniedError),
					getLocalChanges: jest.fn(),
					remoteUpdated: jest.fn(),
					getRemoteTreeSha: jest.fn(),
					getRemoteChanges: jest.fn(),
					getClashedChanges: jest.fn(),
				} as unknown as Fit;

				fitSync = new FitSync(mockFit, saveLocalStoreCallback);
				const notice = { setMessage: jest.fn() } as unknown as FitNotice;

				// Act
				const result = await fitSync.sync(notice);

				// Assert - 403 should be classified as remote access error
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toEqual({
						type: 'remote_access',
						detailMessage: 'Access denied (token missing permissions?)',
						details: {
							source: 'getUser',
							originalError: accessDeniedError
						}
					});
				}
			});

			it.each([
				{
					scenario: 'null status',
					status: null,
					setupResponse: (_error: OctokitHttpError) => { /* no response setup needed */ }
				},
				{
					scenario: 'fake 500 status without response',
					status: 500,
					setupResponse: (error: OctokitHttpError) => { (error as unknown as { response?: unknown }).response = undefined; } // What we've observed from Octokit in practice
				}
			])('should correctly classify network connectivity errors with $scenario', async ({ status, setupResponse }) => {
				// Arrange - Mock network connectivity failure
				const networkError = new OctokitHttpError('Network request failed', status, 'getRef');
				setupResponse(networkError);

				const mockFit = {
					computeLocalSha: jest.fn().mockRejectedValue(networkError),
					getLocalChanges: jest.fn(),
					remoteUpdated: jest.fn(),
					getRemoteTreeSha: jest.fn(),
					getRemoteChanges: jest.fn(),
					getClashedChanges: jest.fn(),
				} as unknown as Fit;

				fitSync = new FitSync(mockFit, saveLocalStoreCallback);
				const notice = { setMessage: jest.fn() } as unknown as FitNotice;

				// Act
				const result = await fitSync.sync(notice);

				// Assert - Network errors should be classified as network type
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toEqual({
						type: 'network',
						detailMessage: "Couldn't reach GitHub API",
						details: {
							source: 'getRef',
							originalError: networkError
						}
					});
				}
			});

			it('should correctly classify real 500 server errors with response', async () => {
				// Arrange - Mock real GitHub API 500 server error with response
				const realServerError = new OctokitHttpError('Internal Server Error', 500, 'getRef');
				// Simulate a real 500 error with proper response object
				(realServerError as unknown as { response?: unknown }).response = {
					status: 500,
					headers: { 'x-github-request-id': '123456' },
					data: { message: 'Internal Server Error' }
				};

				const mockFit = {
					computeLocalSha: jest.fn().mockRejectedValue(realServerError),
					getLocalChanges: jest.fn(),
					remoteUpdated: jest.fn(),
					getRemoteTreeSha: jest.fn(),
					getRemoteChanges: jest.fn(),
					getClashedChanges: jest.fn(),
				} as unknown as Fit;

				fitSync = new FitSync(mockFit, saveLocalStoreCallback);
				const notice = { setMessage: jest.fn() } as unknown as FitNotice;

				// Act
				const result = await fitSync.sync(notice);

				// Assert - Real 500 with response should be classified as API error
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toEqual({
						type: 'api_error',
						detailMessage: 'GitHub API error',
						details: {
							source: 'getRef',
							originalError: realServerError
						}
					});
				}
			});

			it('should correctly classify filesystem errors during sync operations', async () => {
				// Arrange - Set up scenario where vault operation fails with filesystem error
				const obsidianFile = '.obsidian/community-plugins.json';
				const filesystemError = new Error(`EACCES: permission denied, delete '${obsidianFile}'`);

				const mockFit = {
					computeLocalSha: jest.fn().mockResolvedValue({ 'file1.txt': 'sha1' }),
					getLocalChanges: jest.fn().mockResolvedValue([]),
					remoteUpdated: jest.fn().mockResolvedValue({
						remoteCommitSha: 'commit123',
						updated: true
					}),
					getRemoteTreeSha: jest.fn().mockResolvedValue({}),
					getRemoteChanges: jest.fn().mockResolvedValue([
						{ path: obsidianFile, status: 'REMOVED' as const }
					]),
					getClashedChanges: jest.fn().mockReturnValue([]),
					localVault: {
						applyChanges: jest.fn().mockRejectedValue(filesystemError)
					}
				} as unknown as Fit;

				fitSync = new FitSync(mockFit, saveLocalStoreCallback);
				const notice = { setMessage: jest.fn() } as unknown as FitNotice;

				// Act
				const result = await fitSync.sync(notice);

				// Assert - Filesystem errors should be caught and properly classified
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toEqual({
						type: 'filesystem',
						detailMessage: 'EACCES: permission denied, delete \'.obsidian/community-plugins.json\'',
						details: {
							originalError: filesystemError
						}
					});
				}
			});
		});
	});
});
