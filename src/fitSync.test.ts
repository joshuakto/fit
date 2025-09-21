import { FitSync } from './fitSync';
import { Fit, OctokitHttpError } from './fit';
import { VaultOperations } from './vaultOps';
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
      vaultOps: {} as VaultOperations,
    } as unknown as Fit;

    const mockVaultOps = {
      updateLocalFiles: jest.fn().mockResolvedValue([{ path: 'file.txt', status: 'created' as const }] as FileOpRecord[]),
    } as unknown as VaultOperations;

    return new FitSync(mockFit, mockVaultOps, saveLocalStoreCallback);
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
      expect(result).toEqual({ success: true, operations: [], conflicts: [] });
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
      expect(result).toEqual({ success: true, operations: [], conflicts: [] });
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
        operations: [{ heading: 'Local file updates:', ops: localChanges }],
        conflicts: []
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
        operations: [{ heading: 'Local file updates:', ops: mockFileOps }],
        conflicts: []
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
        operations: [
          { heading: 'Local file updates:', ops: mockLocalOps },
          { heading: 'Remote file updates:', ops: mockRemoteOps }
        ],
        conflicts: []
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
        operations: [
          { heading: 'Local file updates:', ops: conflictFileOps },
          { heading: 'Remote file updates:', ops: [] }
        ],
        conflicts: clashedFiles
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

    // Error scenario tests for improved error messaging
    describe('error scenarios', () => {
      it('should return network error for connection issues', async () => {
        // Arrange - Mock a network failure
        const mockFit = {
          computeLocalSha: jest.fn().mockRejectedValue(new Error('fetch failed')),
          getLocalChanges: jest.fn(),
          remoteUpdated: jest.fn(),
          getRemoteTreeSha: jest.fn(),
          getRemoteChanges: jest.fn(),
          getClashedChanges: jest.fn(),
        } as unknown as Fit;

        const mockVaultOps = {} as VaultOperations;
        fitSync = new FitSync(mockFit, mockVaultOps, saveLocalStoreCallback);
        const notice = { setMessage: jest.fn() } as unknown as FitNotice;

        // Act
        const result = await fitSync.sync(notice);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.type).toBe('network');
          expect(result.error.message).toContain('fetch failed');
        }
      });

      it('should return auth error for GitHub HTTP 401 errors', async () => {
        // Arrange - Mock GitHub API 401 error using the real OctokitHttpError class
        const githubError = new OctokitHttpError('Bad credentials', 401, 'getUser');
        const mockFit = {
          computeLocalSha: jest.fn().mockRejectedValue(githubError),
          getLocalChanges: jest.fn(),
          remoteUpdated: jest.fn(),
          getRemoteTreeSha: jest.fn(),
          getRemoteChanges: jest.fn(),
          getClashedChanges: jest.fn(),
        } as unknown as Fit;

        const mockVaultOps = {} as VaultOperations;
        fitSync = new FitSync(mockFit, mockVaultOps, saveLocalStoreCallback);
        const notice = { setMessage: jest.fn() } as unknown as FitNotice;

        // Act
        const result = await fitSync.sync(notice);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.type).toBe('auth');
          expect(result.error.message).toContain('Bad credentials');
        }
      });

      it('should return specific error for branch not found (404 from getRef)', async () => {
        // Arrange - Mock GitHub API 404 error from getRef (branch not found) using the real OctokitHttpError class
        const githubError = new OctokitHttpError('Reference does not exist', 404, 'getRef');
        const mockFit = {
          computeLocalSha: jest.fn().mockRejectedValue(githubError),
          getLocalChanges: jest.fn(),
          remoteUpdated: jest.fn(),
          getRemoteTreeSha: jest.fn(),
          getRemoteChanges: jest.fn(),
          getClashedChanges: jest.fn(),
        } as unknown as Fit;

        const mockVaultOps = {} as VaultOperations;
        fitSync = new FitSync(mockFit, mockVaultOps, saveLocalStoreCallback);
        const notice = { setMessage: jest.fn() } as unknown as FitNotice;

        // Act
        const result = await fitSync.sync(notice);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.type).toBe('repo_not_found');
          expect(result.error.message).toContain('Branch not found');
          expect(result.error.message).toContain('Check repository name and branch name in settings');
        }
      });

      it('should fail when .obsidian file deletion encounters vault operation error', async () => {
        // Arrange - Set up scenario where remote deleted .obsidian file but local deletion fails
        const obsidianFile = '.obsidian/community-plugins.json';

        const mockFit = {
          computeLocalSha: jest.fn().mockResolvedValue({ 'file1.txt': 'sha1' }),
          getLocalChanges: jest.fn().mockResolvedValue([]),
          remoteUpdated: jest.fn().mockResolvedValue({
            remoteCommitSha: 'commit123',
            updated: true
          }),
          getRemoteTreeSha: jest.fn().mockResolvedValue({}), // File deleted from remote
          getRemoteChanges: jest.fn().mockResolvedValue([
            { path: obsidianFile, status: 'REMOVED' as const }
          ]),
          getClashedChanges: jest.fn().mockReturnValue([]),
          vaultOps: {
            updateLocalFiles: jest.fn().mockRejectedValue(
              new Error(`Attempting to delete ${obsidianFile} from local but not successful, file is of type object.`)
            )
          }
        } as unknown as Fit;

        fitSync = new FitSync(mockFit, mockFit.vaultOps, saveLocalStoreCallback);
        const notice = { setMessage: jest.fn() } as unknown as FitNotice;

        // Act
        const result = await fitSync.sync(notice);

        // Assert - Should return filesystem error for .obsidian deletion failure
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.type).toBe('filesystem');
          expect(result.error.message).toContain('Attempting to delete .obsidian/community-plugins.json from local but not successful, file is of type object');
        }
      });
    });
  });
});
