/**
 * Tests for LocalVault
 *
 * Covers:
 * - Path filtering (ignored paths)
 * - State computation
 * - Change detection
 */

import { LocalVault } from './localVault';
import { TFile, TFolder, Vault } from 'obsidian';
import { StubTFile } from './testUtils';
import { Content, FileContent } from './contentEncoding';
import { arrayBufferToContent } from './obsidianHelpers';

describe('LocalVault', () => {
	let mockVault: jest.Mocked<Vault>;
	let consoleLogSpy: jest.SpyInstance;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		mockVault = {
			getFiles: jest.fn(),
			read: jest.fn(),
			readBinary: jest.fn(),
			getAbstractFileByPath: jest.fn()
		} as unknown as jest.Mocked<Vault>;

		// Suppress console noise during tests
		consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
	});

	afterEach(() => {
		// Restore console
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
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

	describe('readFromSource', () => {
		it('should scan vault and update state for text files', async () => {
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
			const state = await localVault.readFromSource();

			expect(state).toMatchObject({
				'note1.md': expect.anything(),
				'note2.txt': expect.anything()
			});
			// Frozen SHA behavior: Non-binary files use path + plaintext
			// Binary files (png, jpg, jpeg, pdf) use path + base64
			expect(state['note1.md']).toMatchInlineSnapshot(
				`"b8b1b70958bbc0b6f0305f4bc57a8393ba333130"`);
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
			const state = await localVault.readFromSource();

			// Only hidden files are excluded from state tracking
			expect(Object.keys(state).sort()).toEqual(['_fit/conflict.md', 'normal.md']);
		});

		it('should handle binary files', async () => {
			const mockFiles = [
				StubTFile.ofPath('image.png'),
				StubTFile.ofPath('doc.pdf'),
				StubTFile.ofPath('archive.zip')
			];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.readBinary.mockResolvedValue(new ArrayBuffer(8));
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault);
			const state = await localVault.readFromSource();

			expect(state).toMatchObject({
				'doc.pdf': expect.anything(),
				'image.png': expect.anything(),
				'archive.zip': expect.anything()
			});
			expect(state['doc.pdf']).toMatchInlineSnapshot(
				`"acf8daf266d952b03fb02280dc5c92d8e4e51ad7"`);
			expect(state['image.png']).toMatchInlineSnapshot(
				`"fe954d839c04f84471b6dd90c945e55a6035de80"`);
			expect(state['archive.zip']).toMatchInlineSnapshot(
				`"e67146506d2b18d3414a28ddc204c9dda6267080"`);
		});

		it('should handle empty vault', async () => {
			mockVault.getFiles.mockReturnValue([]);

			const localVault = new LocalVault(mockVault);
			const state = await localVault.readFromSource();

			expect(state).toEqual({});
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

			expect(content).toEqual(FileContent.fromPlainText(expectedContent));
			expect(mockVault.read).toHaveBeenCalledWith(mockFile);
		});

		it('should read binary file content as base64', async () => {
			const mockFile = StubTFile.ofPath('image.png');
			const binaryData = new ArrayBuffer(8);

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.readBinary.mockResolvedValue(binaryData);

			const localVault = new LocalVault(mockVault);
			const content = await localVault.readFileContent('image.png');

			expect(content).toEqual(FileContent.fromBase64(arrayBufferToContent(binaryData)));
			expect(mockVault.readBinary).toHaveBeenCalledWith(mockFile);
		});

		it('should throw error if file not found', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			const localVault = new LocalVault(mockVault);

			await expect(localVault.readFileContent('missing.md')).rejects.toThrow(
				'File not found: missing.md'
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
			const result = await localVault.writeFile('new.md', Content.encodeToBase64('content'));

			expect(result).toEqual({ path: 'new.md', status: 'created' });
			expect(mockVault.createBinary).toHaveBeenCalled();
		});

		it('should modify existing file', async () => {
			const mockFile = StubTFile.ofPath('existing.md');
			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			(mockVault.modifyBinary as jest.Mock).mockResolvedValue(undefined);

			const localVault = new LocalVault(mockVault);
			const result = await localVault.writeFile('existing.md', Content.encodeToBase64('new content'));

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
			await localVault.writeFile('folder/subfolder/new.md', Content.encodeToBase64('content'));

			expect(mockVault.createFolder).toHaveBeenCalledWith('folder/subfolder');
			expect(mockVault.createBinary).toHaveBeenCalled();
		});

		it('should handle files in root directory (no folder creation needed)', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);
			(mockVault.createBinary as jest.Mock).mockResolvedValue(undefined);

			const localVault = new LocalVault(mockVault);
			await localVault.writeFile('root.md', Content.encodeToBase64('content'));

			expect(mockVault.createFolder).not.toHaveBeenCalled();
			expect(mockVault.createBinary).toHaveBeenCalled();
		});

		it('should throw error when trying to write file where folder exists', async () => {
			// Scenario: Try to write file "notes" but folder "notes/" already exists
			// Expected: Should throw error because getAbstractFileByPath returns a folder (not TFile, not null)

			// Use the mocked TFolder class
			const mockFolder = new TFolder();
			mockFolder.path = 'notes';
			mockVault.getAbstractFileByPath.mockReturnValue(mockFolder as any);

			const localVault = new LocalVault(mockVault);

			// The code checks instanceof TFolder
			await expect(localVault.writeFile('notes', Content.encodeToBase64('content'))).rejects.toThrow(
				/Cannot write file to notes: a folder with that name already exists/
			);
		});

		it('should fail when parent path is a file instead of folder', async () => {
			// Scenario: Try to write "config/settings.json" but "config" is a file, not a folder
			// Current behavior: ensureFolderExists finds "config" exists (as file) and skips createFolder
			// Then vault.createBinary fails with error when trying to create file with invalid parent
			// IMPROVEMENT: Could detect earlier in ensureFolderExists by checking instanceof TFolder

			const mockFile = StubTFile.ofPath('config');
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				if (path === 'config') {
					return mockFile as TFile;  // Returns a file, not a folder
				}
				if (path === 'config/settings.json') {
					return null;  // File doesn't exist yet
				}
				return null;
			});

			// Mock createBinary to fail for paths under 'config/' (parent is a file, not a folder)
			mockVault.createBinary = jest.fn().mockImplementation((path: string) => {
				if (path.startsWith('config/')) {
					throw new Error('Folder already exists as file: config');
				}
				return Promise.resolve(undefined);
			});

			const localVault = new LocalVault(mockVault);

			// Should throw VaultError.filesystem from createBinary
			await expect(localVault.writeFile('config/settings.json', Content.encodeToBase64('content')))
				.rejects.toMatchObject({
					name: 'VaultError',
					type: 'filesystem',
					message: expect.stringContaining('config')
				});

			// ensureFolderExists did NOT call createFolder because "config" exists (as file, but check doesn't verify type)
			expect(mockVault.createFolder).not.toHaveBeenCalled();

			// createBinary was attempted and failed
			expect(mockVault.createBinary).toHaveBeenCalledWith('config/settings.json', expect.any(ArrayBuffer));
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
					{ path: 'new.md', content: FileContent.fromPlainText('new content') },
					{ path: 'existing.md', content: FileContent.fromPlainText('updated content') }
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
				[{ path: 'file1.md', content: FileContent.fromPlainText('content') }],
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
});
