/**
 * Tests to cover behaviors in the FitSync component.
 */

import { FitSync } from './fitSync';
import { Fit } from './fit';
import FitNotice from './fitNotice';
import { FitSettings, LocalStores } from '../main';
import { LocalChange, RemoteChange } from './fitTypes';

// Simple test doubles focused on behavior
describe('FitSync', () => {
	let saveLocalStoreCallback: jest.MockedFunction<(localStore: Partial<LocalStores>) => Promise<void>>;

	function createFakeFit(
		scenario: {
			localPendingChanges?: LocalChange[],
			remotePendingChanges?: { commitSha: string | null, changes: RemoteChange[] },
			simulateError?: Error, // Inject error for error classification tests
			simulateApplyChangesError?: Error, // Inject error in filesystem-specific calls
		},
		settings?: FitSettings) {
		// Stateful fake that simulates Fit behavior:
		// - Changes are consumed when getLocalChanges/getRemoteChanges is called
		// - State transitions from "has changes" to "no changes" after first scan
		let localChanges = scenario.localPendingChanges ?? [];
		let remoteChanges = scenario.remotePendingChanges?.changes ?? [];
		const remoteCommitSha = scenario.remotePendingChanges?.commitSha ?? null;

		const fakeFit = {
			// Core change detection methods
			async remoteUpdated() {
				return {
					remoteCommitSha: remoteCommitSha || '',
					updated: remoteChanges.length > 0 || remoteCommitSha !== null,
				};
			},
			async getLocalChanges() {
				if (scenario.simulateError) {
					throw scenario.simulateError;
				}
				const changes = localChanges;
				localChanges = []; // Consumed after first scan
				return { changes, state: {} };
			},
			async getRemoteChanges() {
				const changes = remoteChanges;
				remoteChanges = []; // Consumed after first scan
				return { changes, state: {} };
			},
			getClashedChanges(_localChanges: LocalChange[], _remoteChanges: RemoteChange[]) {
				return [];
			},
			async createTreeNodeFromFile() {
				return null;
			},

			// TODO: FitSync currently accesses vault internals directly - these shouldn't be needed
			// once we refactor FitSync to use higher-level Fit methods instead
			localVault: {
				async applyChanges(_toWrite: Array<{path: string, content: string}>, _toDelete: string[]) {
					if (scenario.simulateApplyChangesError) {
						throw scenario.simulateApplyChangesError;
					}
					// Return ops matching what was requested
					return _toWrite.map(f => ({ path: f.path, status: 'created' as const }));
				},
				async updateFromSource() { return {}; },
				async readFileContent() { return ''; },
				async writeFile(path: string) { return { path, status: 'created' as const }; },
			},
			remoteVault: {
				async getTree() { return []; },
				async updateRef() { return 'newCommitSha'; },
				async readFileContent() { return ''; },
				getOwner() { return settings?.owner; },
				getRepo() { return settings?.repo; },
				getBranch() { return settings?.branch; },
			},
			async getRemoteTreeSha() { return {}; },
		};
		return fakeFit as unknown as Fit;
	}

	beforeEach(() => {
		saveLocalStoreCallback = jest.fn().mockResolvedValue(undefined);
	});

	describe('sync', () => {
		it('should complete successfully when files are already in sync', async () => {
			// Arrange
			const fitSync = new FitSync(createFakeFit({}), saveLocalStoreCallback);
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({ success: true, ops: [], clash: [] });
			expect(notice.setMessage).toHaveBeenCalledWith('Performing pre sync checks.');
			expect(notice.setMessage).toHaveBeenCalledWith('Sync successful');
		});

		it('should update commit SHA when only remote commit changed', async () => {
			// Arrange
			const newCommitSha = 'newCommit456';
			const fitSync = new FitSync(createFakeFit({
				remotePendingChanges: {
					commitSha: newCommitSha,
					changes: []
				}
			}), saveLocalStoreCallback);
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Act
			const result = await fitSync.sync(notice);

			// Assert
			expect(result).toEqual({ success: true, ops: [], clash: [] });
			expect(saveLocalStoreCallback).toHaveBeenCalledWith({
				lastFetchedCommitSha: newCommitSha
			});
			expect(notice.setMessage).toHaveBeenCalledWith('Performing pre sync checks.');
			expect(notice.setMessage).toHaveBeenCalledWith('Sync successful');
		});

		it('should handle local changes scenario', async () => {
			// Arrange
			const localChanges = [{ path: 'file1.txt', status: 'changed' as const }];
			const fitSync = new FitSync(createFakeFit({
				localPendingChanges: localChanges
			}), saveLocalStoreCallback);
			const notice = { setMessage: jest.fn() } as unknown as FitNotice;

			// Mock the push behavior - FitPush is instantiated by FitSync
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
			const fitSync = new FitSync(
				createFakeFit({
					remotePendingChanges: {
						commitSha: 'commit123',
						changes: remoteChanges
					}
				}),
				saveLocalStoreCallback);
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

			const fitSync = new FitSync(
				createFakeFit({
					localPendingChanges: localChanges,
					remotePendingChanges: {
						commitSha: 'commit456',
						changes: remoteChanges
					}
				}),
				saveLocalStoreCallback);
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

			const fitSync = new FitSync(
				createFakeFit({
					localPendingChanges: localChanges,
					remotePendingChanges: {
						commitSha: 'commit456',
						changes: remoteChanges
					}
				}),
				saveLocalStoreCallback);

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
			const fitSync = new FitSync(createFakeFit({}), saveLocalStoreCallback);
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

	});
});
