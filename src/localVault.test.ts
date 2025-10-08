/**
 * Tests for LocalVault
 *
 * Covers:
 * - Path filtering (ignored paths)
 * - State computation
 * - Change detection
 */

import { LocalVault } from './localVault';
import { TFile, Vault } from 'obsidian';
import { FileState } from './vault';
import { StubTFile } from './testUtils';

describe('LocalVault', () => {
	let mockVault: jest.Mocked<Vault>;

	beforeEach(() => {
		mockVault = {
			getFiles: jest.fn(),
			read: jest.fn(),
			readBinary: jest.fn(),
			getAbstractFileByPath: jest.fn()
		} as unknown as jest.Mocked<Vault>;
	});

	describe('shouldTrackState', () => {
		it('should exclude hidden files (starting with .)', () => {
			const localVault = new LocalVault(mockVault);

			expect(localVault.shouldTrackState('.obsidian/config.json')).toBe(false);
			expect(localVault.shouldTrackState('.gitignore')).toBe(false);
			expect(localVault.shouldTrackState('.DS_Store')).toBe(false);
		});

		it('should exclude files in hidden directories', () => {
			const localVault = new LocalVault(mockVault);

			expect(localVault.shouldTrackState('.obsidian/plugins/fit/main.js')).toBe(false);
			expect(localVault.shouldTrackState('folder/.hidden/file.md')).toBe(false);
		});

		it('should track normal files', () => {
			const localVault = new LocalVault(mockVault);

			expect(localVault.shouldTrackState('notes/daily/2024-01-01.md')).toBe(true);
			expect(localVault.shouldTrackState('README.md')).toBe(true);
			expect(localVault.shouldTrackState('fit_documentation.md')).toBe(true); // "fit" in name is OK
		});

		it('should handle edge cases', () => {
			const localVault = new LocalVault(mockVault);

			expect(localVault.shouldTrackState('normal/fit/file.md')).toBe(true); // "fit" as folder name is OK
			expect(localVault.shouldTrackState('_fit')).toBe(true); // _fit as a filename (without /) IS tracked
			expect(localVault.shouldTrackState('_fit/')).toBe(true); // _fit/ directory is tracked (filtering done by Fit.shouldSyncPath)
			expect(localVault.shouldTrackState('_fit/conflict.md')).toBe(true); // Files in _fit/ are tracked by LocalVault
		});
	});

	describe('computeCurrentState', () => {
		it('should compute state for text files', async () => {
			const mockFiles = [
				StubTFile.ofPath('note1.md'),
				StubTFile.ofPath('note2.txt')
			];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.read.mockImplementation(async (file: TFile) => {
				if (file.path === 'note1.md') return 'Content of note 1';
				if (file.path === 'note2.txt') return 'Content of note 2';
				return '';
			});
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault);
			const state = await localVault.computeCurrentState();

			expect(Object.keys(state).sort()).toEqual(['note1.md', 'note2.txt']);
		});

		it('should exclude ignored paths from state', async () => {
			const mockFiles = [
				StubTFile.ofPath('normal.md'),
				StubTFile.ofPath('_fit/conflict.md'),
				StubTFile.ofPath('.obsidian/config.json')
			];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.read.mockResolvedValue('file content');
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault);
			const state = await localVault.computeCurrentState();

			// Only hidden files are excluded from state tracking
			expect(Object.keys(state).sort()).toEqual(['_fit/conflict.md', 'normal.md']);
		});

		it('should handle binary files', async () => {
			const mockFiles = [
				StubTFile.ofPath('image.png'),
				StubTFile.ofPath('doc.pdf')
			];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.readBinary.mockResolvedValue(new ArrayBuffer(8));
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault);
			const state = await localVault.computeCurrentState();

			expect(Object.keys(state).sort()).toEqual(['doc.pdf', 'image.png']);
		});

		it('should handle empty vault', async () => {
			mockVault.getFiles.mockReturnValue([]);

			const localVault = new LocalVault(mockVault);
			const state = await localVault.computeCurrentState();

			expect(state).toEqual({});
		});
	});

	describe('getChanges', () => {
		it('should detect newly created files', async () => {
			const baselineState: FileState = {};
			const mockFiles = [StubTFile.ofPath('new.md')];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.read.mockResolvedValue('new content');
			mockVault.getAbstractFileByPath.mockReturnValue(mockFiles[0] as TFile);

			const localVault = new LocalVault(mockVault);
			const changes = await localVault.getChanges(baselineState);

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				path: 'new.md',
				status: 'created'
			});
		});

		it('should detect modified files', async () => {
			// Baseline with old SHA
			const baselineState: FileState = {
				'note.md': 'old_sha_hash'
			};

			const mockFiles = [StubTFile.ofPath('note.md')];
			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.read.mockResolvedValue('modified content'); // Different content = different SHA
			mockVault.getAbstractFileByPath.mockReturnValue(mockFiles[0] as TFile);

			const localVault = new LocalVault(mockVault);
			const changes = await localVault.getChanges(baselineState);

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				path: 'note.md',
				status: 'changed'
			});
		});

		it('should detect deleted files', async () => {
			const baselineState: FileState = {
				'deleted.md': 'some_sha',
				'still-here.md': 'another_sha'
			};

			const mockFiles = [StubTFile.ofPath('still-here.md')];
			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.read.mockResolvedValue('content');
			mockVault.getAbstractFileByPath.mockReturnValue(mockFiles[0] as TFile);

			const localVault = new LocalVault(mockVault);
			const changes = await localVault.getChanges(baselineState);

			const deletedChange = changes.find(c => c.path === 'deleted.md');
			expect(deletedChange).toBeDefined();
			expect(deletedChange?.status).toBe('deleted');
		});

		it('should return empty array when no changes', async () => {
			const mockFiles = [StubTFile.ofPath('unchanged.md')];
			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.read.mockResolvedValue('same content');
			mockVault.getAbstractFileByPath.mockReturnValue(mockFiles[0] as TFile);

			const localVault = new LocalVault(mockVault);
			const currentState = await localVault.computeCurrentState();

			// Use same state as baseline
			const changes = await localVault.getChanges(currentState);

			expect(changes).toHaveLength(0);
		});
	});

	describe('baseline state management', () => {
		it('should update baseline state', () => {
			const localVault = new LocalVault(mockVault, {});
			const newState: FileState = {
				'file1.md': 'sha1',
				'file2.md': 'sha2'
			};

			localVault.updateBaselineState(newState);
			const retrievedState = localVault.getBaselineState();

			expect(retrievedState).toEqual(newState);
		});

		it('should initialize with provided baseline', () => {
			const initialBaseline: FileState = {
				'existing.md': 'sha_existing'
			};

			const localVault = new LocalVault(mockVault, initialBaseline);
			const retrievedState = localVault.getBaselineState();

			expect(retrievedState).toEqual(initialBaseline);
		});

		it('should return copy of baseline state (not reference)', () => {
			const initialBaseline: FileState = {
				'file.md': 'sha'
			};

			const localVault = new LocalVault(mockVault, initialBaseline);
			const state1 = localVault.getBaselineState();
			const state2 = localVault.getBaselineState();

			// Modify one copy
			state1['modified.md'] = 'new_sha';

			// Other copy should be unaffected
			expect(state2).not.toHaveProperty('modified.md');
			expect(localVault.getBaselineState()).toEqual(initialBaseline);
		});
	});

	describe('readFileContent', () => {
		beforeEach(() => {
			mockVault.getAbstractFileByPath = jest.fn();
			mockVault.read = jest.fn();
			mockVault.readBinary = jest.fn();
		});

		it('should read text file content', async () => {
			const mockFile = StubTFile.ofPath('note.md');
			const expectedContent = 'This is a text file';

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.read.mockResolvedValue(expectedContent);

			const localVault = new LocalVault(mockVault);
			const content = await localVault.readFileContent('note.md');

			expect(content).toBe(expectedContent);
			expect(mockVault.read).toHaveBeenCalledWith(mockFile);
		});

		it('should read binary file content as base64', async () => {
			const mockFile = StubTFile.ofPath('image.png');
			const binaryData = new ArrayBuffer(8);

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.readBinary.mockResolvedValue(binaryData);

			const localVault = new LocalVault(mockVault);
			const content = await localVault.readFileContent('image.png');

			expect(typeof content).toBe('string'); // Should be base64 encoded
			expect(mockVault.readBinary).toHaveBeenCalledWith(mockFile);
		});

		it('should throw error if file not found', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			const localVault = new LocalVault(mockVault);

			await expect(localVault.readFileContent('missing.md')).rejects.toThrow(
				'Attempting to read missing.md from local drive as TFile but not successful'
			);
		});
	});

	describe('writeFile', () => {
		beforeEach(() => {
			mockVault.getAbstractFileByPath = jest.fn();
			mockVault.createBinary = jest.fn();
			mockVault.modifyBinary = jest.fn();
			mockVault.createFolder = jest.fn();
		});

		it('should create new file when it does not exist', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null); // File doesn't exist
			(mockVault.createBinary as jest.Mock).mockResolvedValue(undefined);

			const localVault = new LocalVault(mockVault);
			const result = await localVault.writeFile('new.md', 'content');

			expect(result).toEqual({ path: 'new.md', status: 'created' });
			expect(mockVault.createBinary).toHaveBeenCalled();
		});

		it('should modify existing file', async () => {
			const mockFile = StubTFile.ofPath('existing.md');
			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			(mockVault.modifyBinary as jest.Mock).mockResolvedValue(undefined);

			const localVault = new LocalVault(mockVault);
			const result = await localVault.writeFile('existing.md', 'new content');

			expect(result).toEqual({ path: 'existing.md', status: 'changed' });
			expect(mockVault.modifyBinary).toHaveBeenCalledWith(mockFile, expect.anything());
		});

		it('should create parent folders when creating new file', async () => {
			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				// File doesn't exist, but folder check will be called
				if (path === 'folder/subfolder/new.md') return null;
				if (path === 'folder/subfolder') return null; // Folder doesn't exist
				return null;
			});
			(mockVault.createFolder as jest.Mock).mockResolvedValue(undefined);
			(mockVault.createBinary as jest.Mock).mockResolvedValue(undefined);

			const localVault = new LocalVault(mockVault);
			await localVault.writeFile('folder/subfolder/new.md', 'content');

			expect(mockVault.createFolder).toHaveBeenCalledWith('folder/subfolder');
			expect(mockVault.createBinary).toHaveBeenCalled();
		});

		it('should handle files in root directory (no folder creation needed)', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);
			(mockVault.createBinary as jest.Mock).mockResolvedValue(undefined);

			const localVault = new LocalVault(mockVault);
			await localVault.writeFile('root.md', 'content');

			expect(mockVault.createFolder).not.toHaveBeenCalled();
			expect(mockVault.createBinary).toHaveBeenCalled();
		});
	});

	describe('deleteFile', () => {
		beforeEach(() => {
			mockVault.getAbstractFileByPath = jest.fn();
			mockVault.delete = jest.fn();
		});

		it('should delete existing file', async () => {
			const mockFile = StubTFile.ofPath('delete-me.md');
			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.delete.mockResolvedValue(undefined);

			const localVault = new LocalVault(mockVault);
			const result = await localVault.deleteFile('delete-me.md');

			expect(result).toEqual({ path: 'delete-me.md', status: 'deleted' });
			expect(mockVault.delete).toHaveBeenCalledWith(mockFile);
		});

		it('should throw error when file does not exist', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			const localVault = new LocalVault(mockVault);

			await expect(localVault.deleteFile('missing.md')).rejects.toThrow(
				'Attempting to delete missing.md from local but not successful'
			);
		});
	});

	describe('applyChanges', () => {
		beforeEach(() => {
			mockVault.getAbstractFileByPath = jest.fn();
			mockVault.createBinary = jest.fn().mockResolvedValue(undefined);
			mockVault.modifyBinary = jest.fn().mockResolvedValue(undefined);
			mockVault.delete = jest.fn().mockResolvedValue(undefined);
			mockVault.createFolder = jest.fn().mockResolvedValue(undefined);
		});

		it('should apply multiple writes and deletes', async () => {
			const existingFile = StubTFile.ofPath('existing.md');
			const fileToDelete = StubTFile.ofPath('delete.md');

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'new.md') return null;
				if (path === 'existing.md') return existingFile as TFile;
				if (path === 'delete.md') return fileToDelete as TFile;
				return null;
			});

			const localVault = new LocalVault(mockVault);
			const results = await localVault.applyChanges(
				[
					{ path: 'new.md', content: 'new content' },
					{ path: 'existing.md', content: 'updated content' }
				],
				['delete.md']
			);

			expect(results).toHaveLength(3);
			expect(results).toContainEqual({ path: 'new.md', status: 'created' });
			expect(results).toContainEqual({ path: 'existing.md', status: 'changed' });
			expect(results).toContainEqual({ path: 'delete.md', status: 'deleted' });
		});

		it('should handle empty changes', async () => {
			const localVault = new LocalVault(mockVault);
			const results = await localVault.applyChanges([], []);

			expect(results).toEqual([]);
		});

		it('should process writes and deletes in parallel', async () => {
			const file1 = StubTFile.ofPath('file1.md');
			const file2 = StubTFile.ofPath('file2.md');

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'file1.md') return file1 as TFile;
				if (path === 'file2.md') return file2 as TFile;
				return null;
			});

			const localVault = new LocalVault(mockVault);

			// Track call order - if parallel, all should start before any finish
			const callOrder: string[] = [];
			mockVault.modifyBinary.mockImplementation(async () => {
				callOrder.push('modify-start');
				await new Promise(resolve => setTimeout(resolve, 10));
				callOrder.push('modify-end');
			});
			mockVault.delete.mockImplementation(async () => {
				callOrder.push('delete-start');
				await new Promise(resolve => setTimeout(resolve, 10));
				callOrder.push('delete-end');
			});

			await localVault.applyChanges(
				[{ path: 'file1.md', content: 'content' }],
				['file2.md']
			);

			// Both should start before either finishes (parallel execution)
			const firstStartIndex = Math.min(
				callOrder.indexOf('modify-start'),
				callOrder.indexOf('delete-start')
			);
			const firstEndIndex = Math.min(
				callOrder.indexOf('modify-end'),
				callOrder.indexOf('delete-end')
			);

			expect(callOrder.filter(c => c.endsWith('-start')).length).toBe(2);
			expect(firstEndIndex).toBeGreaterThan(firstStartIndex);
		});
	});

	describe('createCopyInDir', () => {
		beforeEach(() => {
			mockVault.getAbstractFileByPath = jest.fn();
			mockVault.readBinary = jest.fn();
			mockVault.createBinary = jest.fn().mockResolvedValue(undefined);
			mockVault.modifyBinary = jest.fn().mockResolvedValue(undefined);
			mockVault.createFolder = jest.fn().mockResolvedValue(undefined);
			mockVault.delete = jest.fn().mockResolvedValue(undefined);
		});

		it('should create copy in _fit/ directory', async () => {
			const sourceFile = StubTFile.ofPath('original.md');
			const binaryContent = new ArrayBuffer(8);

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'original.md') return sourceFile as TFile;
				if (path === '_fit/original.md') return null; // Copy doesn't exist yet
				if (path === '_fit') return null; // Folder doesn't exist
				return null;
			});
			mockVault.readBinary.mockResolvedValue(binaryContent);

			const localVault = new LocalVault(mockVault);
			await localVault.createCopyInDir('original.md');

			expect(mockVault.readBinary).toHaveBeenCalledWith(sourceFile);
			expect(mockVault.createFolder).toHaveBeenCalledWith('_fit');
			expect(mockVault.createBinary).toHaveBeenCalledWith('_fit/original.md', binaryContent);
		});

		it('should update existing copy', async () => {
			const sourceFile = StubTFile.ofPath('original.md');
			const existingCopy = StubTFile.ofPath('_fit/original.md');
			const binaryContent = new ArrayBuffer(8);

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'original.md') return sourceFile as TFile;
				if (path === '_fit/original.md') return existingCopy as TFile;
				return null;
			});
			mockVault.readBinary.mockResolvedValue(binaryContent);

			const localVault = new LocalVault(mockVault);
			await localVault.createCopyInDir('original.md');

			expect(mockVault.modifyBinary).toHaveBeenCalledWith(existingCopy, binaryContent);
			expect(mockVault.createBinary).not.toHaveBeenCalled();
		});

		it('should support custom copy directory', async () => {
			const sourceFile = StubTFile.ofPath('original.md');
			const binaryContent = new ArrayBuffer(8);

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'original.md') return sourceFile as TFile;
				if (path === 'custom/original.md') return null;
				if (path === 'custom') return null;
				return null;
			});
			mockVault.readBinary.mockResolvedValue(binaryContent);

			const localVault = new LocalVault(mockVault);
			await localVault.createCopyInDir('original.md', 'custom');

			expect(mockVault.createFolder).toHaveBeenCalledWith('custom');
			expect(mockVault.createBinary).toHaveBeenCalledWith('custom/original.md', binaryContent);
		});

		it('should create nested folders for deep paths', async () => {
			const sourceFile = StubTFile.ofPath('deep/nested/file.md');
			const binaryContent = new ArrayBuffer(8);

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'deep/nested/file.md') return sourceFile as TFile;
				if (path === '_fit/deep/nested/file.md') return null;
				if (path === '_fit/deep/nested') return null;
				return null;
			});
			mockVault.readBinary.mockResolvedValue(binaryContent);

			const localVault = new LocalVault(mockVault);
			await localVault.createCopyInDir('deep/nested/file.md');

			expect(mockVault.createFolder).toHaveBeenCalledWith('_fit/deep/nested');
			expect(mockVault.createBinary).toHaveBeenCalledWith('_fit/deep/nested/file.md', binaryContent);
		});

		it('should throw error if source file does not exist', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			const localVault = new LocalVault(mockVault);

			await expect(localVault.createCopyInDir('missing.md')).rejects.toThrow(
				'Attempting to create copy of missing.md from local drive as TFile but not successful'
			);
		});
	});
});
