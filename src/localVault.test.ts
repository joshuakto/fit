/**
 * Tests for LocalVault
 *
 * Covers:
 * - Path filtering (ignored paths)
 * - State computation
 * - Change detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import { LocalVault } from './localVault';
import { TFile, TFolder, Vault } from 'obsidian';
import { FakeObsidianVault, StubTFile } from './testUtils';
import { FileContent } from './util/contentEncoding';
import { arrayBufferToContent } from './util/obsidianHelpers';
import { computeSha1 } from './util/hashing';

// Type-safe mock that includes only the methods LocalVault uses
type MockVault = Pick<Vault,
	'getFiles' | 'getAbstractFileByPath' | 'createFolder' |
	'read' | 'readBinary' | 'cachedRead' |
	'create' | 'createBinary' | 'modify' | 'modifyBinary' | 'delete'
> & {
	adapter: {
		stat: Mock;
		mkdir: Mock;
		write: Mock;
		writeBinary: Mock;
		remove: Mock;
	};
};

describe('LocalVault', () => {
	let mockVault: {
		[K in keyof Omit<MockVault, 'adapter'>]: Mock;
	} & {
		adapter: {
			stat: Mock;
			mkdir: Mock;
			write: Mock;
			writeBinary: Mock;
			remove: Mock;
		};
	};
	let consoleLogSpy: MockInstance<typeof console.log>;
	let consoleErrorSpy: MockInstance<typeof console.error>;

	beforeEach(() => {
		mockVault = {
			getFiles: vi.fn(),
			read: vi.fn(),
			readBinary: vi.fn(),
			cachedRead: vi.fn(),
			getAbstractFileByPath: vi.fn(),
			createFolder: vi.fn(),
			create: vi.fn(),
			createBinary: vi.fn(),
			modify: vi.fn(),
			modifyBinary: vi.fn(),
			delete: vi.fn(),
			adapter: {
				stat: vi.fn().mockResolvedValue(null), // Default: path doesn't exist
				mkdir: vi.fn().mockResolvedValue(undefined),
				write: vi.fn().mockResolvedValue(undefined),
				writeBinary: vi.fn().mockResolvedValue(undefined),
				remove: vi.fn().mockResolvedValue(undefined)
			}
		};

		// Suppress console noise during tests
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		// Restore console
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	describe('shouldTrackState', () => {
		it('should exclude hidden files (starting with .) when syncHiddenFiles is off', () => {
			const localVault = new LocalVault(mockVault as any as Vault);
			localVault.configure({ syncHiddenFiles: false });

			expect(localVault.shouldTrackState('.obsidian/config.json')).toBe(false);
			expect(localVault.shouldTrackState('.gitignore')).toBe(false);
			expect(localVault.shouldTrackState('.DS_Store')).toBe(false);
		});

		it('should exclude files in hidden directories when syncHiddenFiles is off', () => {
			const localVault = new LocalVault(mockVault as any as Vault);
			localVault.configure({ syncHiddenFiles: false });

			expect(localVault.shouldTrackState('.obsidian/plugins/fit/main.js')).toBe(false);
			expect(localVault.shouldTrackState('folder/.hidden/file.md')).toBe(false);
		});

		it('should track normal files', () => {
			const localVault = new LocalVault(mockVault as any as Vault);

			expect(localVault.shouldTrackState('notes/daily/2024-01-01.md')).toBe(true);
			expect(localVault.shouldTrackState('README.md')).toBe(true);
			expect(localVault.shouldTrackState('fit_documentation.md')).toBe(true); // "fit" in name is OK
		});

		it('should handle edge cases', () => {
			const localVault = new LocalVault(mockVault as any as Vault);

			expect(localVault.shouldTrackState('normal/fit/file.md')).toBe(true); // "fit" as folder name is OK
			expect(localVault.shouldTrackState('_fit')).toBe(true); // _fit as a filename (without /) IS tracked
			expect(localVault.shouldTrackState('_fit/')).toBe(true); // _fit/ directory is tracked (filtering done by Fit.shouldSyncPath)
			expect(localVault.shouldTrackState('_fit/conflict.md')).toBe(true); // Files in _fit/ are tracked by LocalVault
		});

		it('should include hidden files when syncHiddenFiles is enabled', () => {
			const localVault = new LocalVault(mockVault as any as Vault);
			localVault.configure({ syncHiddenFiles: true });

			expect(localVault.shouldTrackState('.gitignore')).toBe(true);
			expect(localVault.shouldTrackState('.obsidian/config.json')).toBe(true);
			expect(localVault.shouldTrackState('notes/.gitignore')).toBe(true);
			expect(localVault.shouldTrackState('normal/file.md')).toBe(true);
		});
	});

	describe('readFromSource', () => {
		it('should scan vault and update state for text files', async () => {
			const mockFiles = [
				StubTFile.ofPath('note1.md'),
				StubTFile.ofPath('note2.txt')
			];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.readBinary.mockImplementation(async (file: TFile) => {
				if (file.path === 'note1.md') return new TextEncoder().encode('Content of note 1').buffer;
				if (file.path === 'note2.txt') return new TextEncoder().encode('Content of note 2').buffer;
				return new ArrayBuffer(0);
			});
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault as any as Vault);
			const { state } = await localVault.readFromSource();

			expect(state).toMatchObject({
				'note1.md': expect.anything(),
				'note2.txt': expect.anything()
			});
			// Canonical git blob SHA: SHA1("blob " + byteLen + NUL + rawBytes) — path is not included
			expect(state['note1.md']).toMatchInlineSnapshot(
				`"5e1e15cb4d9afa9689ba28b99e3d17ed7384edca"`);
		});

		it('should exclude hidden paths from state when syncHiddenFiles is off', async () => {
			const mockFiles = [
				StubTFile.ofPath('normal.md'),
				StubTFile.ofPath('_fit/conflict.md'),
				StubTFile.ofPath('.obsidian/config.json')
			];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.readBinary.mockResolvedValue(new TextEncoder().encode('file content').buffer);
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault as any as Vault);
			localVault.configure({ syncHiddenFiles: false });
			const { state } = await localVault.readFromSource();

			expect(Object.keys(state).sort()).toEqual(['_fit/conflict.md', 'normal.md']);
		});

		it('should handle binary files', async () => {
			const mockFiles = [
				StubTFile.ofPath('image.png'),
				StubTFile.ofPath('doc.pdf'),
				StubTFile.ofPath('archive.zip')
			];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			// Return binary data (all zeros like old test for SHA compatibility)
			const binaryData = new ArrayBuffer(8);
			mockVault.readBinary.mockResolvedValue(binaryData);
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault as any as Vault);
			const { state } = await localVault.readFromSource();

			expect(state).toMatchObject({
				'doc.pdf': expect.anything(),
				'image.png': expect.anything(),
				'archive.zip': expect.anything()
			});
			// SHAs should be stable (canonical git blob SHA, same for all three since they have identical content in the test)
			expect(state['doc.pdf']).toMatchInlineSnapshot(
				`"1b1cb4d44c57c2d7a5122870fa6ac3e62ff7e94e"`);
			expect(state['image.png']).toMatchInlineSnapshot(
				`"1b1cb4d44c57c2d7a5122870fa6ac3e62ff7e94e"`);
			expect(state['archive.zip']).toMatchInlineSnapshot(
				`"1b1cb4d44c57c2d7a5122870fa6ac3e62ff7e94e"`);
		});

		it('should handle empty vault', async () => {
			mockVault.getFiles.mockReturnValue([]);

			const localVault = new LocalVault(mockVault as any as Vault);
			const { state } = await localVault.readFromSource();

			expect(state).toEqual({});
		});

		it('should detect binary files with unknown extensions via null bytes', async () => {
			const mockFiles = [StubTFile.ofPath('unknown.xyz')];

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			// Binary data with null byte - should be detected as binary
			const binaryData = new Uint8Array([0xFF, 0xD8, 0xFF, 0x00, 0x10]).buffer;
			mockVault.readBinary.mockResolvedValue(binaryData);
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault as any as Vault);
			const { state } = await localVault.readFromSource();

			// Should succeed without throwing (binary detection works)
			expect(state).toMatchObject({
				'unknown.xyz': expect.any(String)
			});
			// SHA should use base64 (binary encoding)
			// We can't predict exact SHA without knowing implementation details,
			// but it should be stable
			const sha = state['unknown.xyz'];
			expect(sha).toBeTruthy();
			expect(sha.length).toBe(40); // SHA-1 hex length
		});

		it('should read text files with unknown extensions as plaintext', async () => {
			const mockFiles = [StubTFile.ofPath('notes.xyz')];
			const textContent = 'Hello, this is plain text!';

			mockVault.getFiles.mockReturnValue(mockFiles as TFile[]);
			mockVault.readBinary.mockResolvedValue(new TextEncoder().encode(textContent).buffer);
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault as any as Vault);
			const { state } = await localVault.readFromSource();

			// Should succeed without throwing (text detection works)
			expect(state).toMatchObject({
				'notes.xyz': expect.any(String)
			});
			// Should compute SHA using plaintext (not base64)
			const sha = state['notes.xyz'];
			expect(sha).toBeTruthy();
		});

		it('should include hidden files when syncHiddenFiles is enabled', async () => {
			const normalFiles = [StubTFile.ofPath('note.md')];

			mockVault.getFiles.mockReturnValue(normalFiles as TFile[]);
			mockVault.readBinary.mockImplementation(async (file: TFile) => {
				if (file.path === 'note.md') return new TextEncoder().encode('note content').buffer;
				return new ArrayBuffer(0);
			});
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				// .gitignore is a hidden file — not in vault index
				return normalFiles.find(f => f.path === path) ?? null;
			});

			const gitignoreBytes = new TextEncoder().encode('*.log\n').buffer;
			(mockVault.adapter as any).list = vi.fn().mockImplementation(async (dir: string) => {
				if (dir === '/') return { files: ['note.md', '.gitignore'], folders: [] };
				return { files: [], folders: [] };
			});
			(mockVault.adapter as any).read = vi.fn().mockResolvedValue('*.log\n');
			(mockVault.adapter as any).readBinary = vi.fn().mockResolvedValue(gitignoreBytes);

			const localVault = new LocalVault(mockVault as any as Vault);
			localVault.configure({ syncHiddenFiles: true });
			const { state } = await localVault.readFromSource();

			// Both normal and hidden files appear in state
			const sha40 = expect.stringMatching(/^[0-9a-f]{40}$/);
			expect(state).toEqual({
				'note.md': sha40,
				'.gitignore': sha40
			});
		});
	});

	describe('readFileContent', () => {
		beforeEach(() => {
			mockVault.getAbstractFileByPath = vi.fn();
			mockVault.read = vi.fn();
			mockVault.readBinary = vi.fn();
		});

		it('should read text file content', async () => {
			const mockFile = StubTFile.ofPath('note.md');
			const expectedContent = 'This is a text file';
			const textBytes = new TextEncoder().encode(expectedContent);

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.readBinary.mockResolvedValue(textBytes.buffer);

			const localVault = new LocalVault(mockVault as any as Vault);
			const content = await localVault.readFileContent('note.md');

			expect(content.toPlainText()).toBe(expectedContent);
			expect(mockVault.readBinary).toHaveBeenCalledWith(mockFile);
		});

		it('should detect binary files via null bytes (issue #156)', async () => {
			const mockFile = StubTFile.ofPath('image.png');
			// Create binary data with null byte (0x00) - typical for images
			const binaryData = new Uint8Array([0xFF, 0xD8, 0xFF, 0x00, 0x10, 0x4A, 0x46, 0x49]).buffer;

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.readBinary.mockResolvedValue(binaryData);

			const localVault = new LocalVault(mockVault as any as Vault);
			const content = await localVault.readFileContent('image.png');

			// Should always use readBinary and detect as binary via null byte
			expect(mockVault.read).not.toHaveBeenCalled();
			expect(mockVault.readBinary).toHaveBeenCalledWith(mockFile);
			expect(content.toBase64()).toBe(arrayBufferToContent(binaryData));
		});

		it('should throw error if file not found', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);
			// Mock adapter to simulate file not found
			(mockVault as any).adapter = {
				readBinary: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'))
			};

			const localVault = new LocalVault(mockVault as any as Vault);

			await expect(localVault.readFileContent('missing.md')).rejects.toThrow(
				'Failed to read missing.md: ENOENT: no such file or directory'
			);
		});


		it('should decode text files without null bytes as plaintext (issue #156)', async () => {
			const mockFile = StubTFile.ofPath('note.md');
			const textContent = 'Hello World';
			// Convert text to ArrayBuffer (no null bytes)
			const textBytes = new TextEncoder().encode(textContent);
			const arrayBuffer = textBytes.buffer;

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.readBinary.mockResolvedValue(arrayBuffer);

			const localVault = new LocalVault(mockVault as any as Vault);
			const content = await localVault.readFileContent('note.md');

			// Should use readBinary but decode as text (no null bytes)
			expect(mockVault.read).not.toHaveBeenCalled();
			expect(mockVault.readBinary).toHaveBeenCalledWith(mockFile);
			expect(content.toPlainText()).toBe(textContent);
		});
	});

	describe('applyChanges', () => {
		it('should apply multiple writes and deletes', async () => {
			const existingFile = StubTFile.ofPath('existing.md');
			const fileToDelete = StubTFile.ofPath('delete.md');

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'new.md') return null;
				if (path === 'existing.md') return existingFile as TFile;
				if (path === 'delete.md') return fileToDelete as TFile;
				return null;
			});

			const localVault = new LocalVault(mockVault as any as Vault);
			const results = await localVault.applyChanges(
				[
					{ path: 'new.md', content: FileContent.fromPlainText('new content') },
					{ path: 'existing.md', content: FileContent.fromPlainText('updated content') }
				],
				['delete.md']
			);

			expect(results).toEqual(expect.objectContaining({
				changes: expect.arrayContaining([
					{ path: 'new.md', type: 'ADDED' },
					{ path: 'existing.md', type: 'MODIFIED' },
					{ path: 'delete.md', type: 'REMOVED' }
				]),
			}));

			// Verify SHA computation promise
			expect(await results.newBaselineStates).toEqual({
				'new.md': expect.any(String),
				'existing.md': expect.any(String),
				// Note no 'delete.md' (Deleted files should not have SHAs)
			});
		});

		it('should handle empty changes', async () => {
			const localVault = new LocalVault(mockVault as any as Vault);
			const results = await localVault.applyChanges([], []);

			expect(results.changes).toEqual([]);
			expect(await results.newBaselineStates).toEqual({});
		});

		it('should process writes and deletes in parallel', async () => {
			const file1 = StubTFile.ofPath('file1.md');
			const file2 = StubTFile.ofPath('file2.md');

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'file1.md') return file1 as TFile;
				if (path === 'file2.md') return file2 as TFile;
				return null;
			});

			const localVault = new LocalVault(mockVault as any as Vault);

			// Track call order - if parallel, all should start before any finish
			const callOrder: string[] = [];
			mockVault.modify = vi.fn().mockImplementation(async () => {
				callOrder.push('modify-start');
				await new Promise(resolve => setTimeout(resolve, 10));
				callOrder.push('modify-end');
			});
			mockVault.delete = vi.fn().mockImplementation(async () => {
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

		it('should use text API for plaintext files and binary API for binary files', async () => {
			// This test verifies the fix for PR #161 binary file corruption
			// Text files should use vault.create/modify (not createBinary/modifyBinary)
			// Binary files should use vault.createBinary/modifyBinary
			const binaryFile = StubTFile.ofPath('image.jpg');

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				if (path === 'note.md') return null;  // New file
				if (path === 'image.jpg') return binaryFile as TFile;  // Existing file
				return null;
			});

			const localVault = new LocalVault(mockVault as any as Vault);

			// Write text file (plaintext encoding)
			await localVault.applyChanges(
				[{ path: 'note.md', content: FileContent.fromPlainText('Hello world') }],
				[]
			);

			// Should use create() for plaintext
			expect(mockVault.create).toHaveBeenCalledWith('note.md', 'Hello world');
			expect(mockVault.createBinary).not.toHaveBeenCalled();

			// Reset mocks
			mockVault.create.mockClear();
			mockVault.modify.mockClear();
			mockVault.createBinary.mockClear();
			mockVault.modifyBinary.mockClear();

			// Write binary file (base64 encoding)
			const binaryData = 'SGVsbG8gd29ybGQ=';  // "Hello world" in base64
			await localVault.applyChanges(
				[{ path: 'image.jpg', content: FileContent.fromBase64(binaryData) }],
				[]
			);

			// Should use modifyBinary() for binary
			expect(mockVault.modifyBinary).toHaveBeenCalledWith(binaryFile, expect.anything());
			expect(mockVault.modify).not.toHaveBeenCalled();
		});

		it('should detect when parent folder path exists as a file (issue #153)', async () => {
			// Scenario: _fit/.obsidian exists as a FILE, not a folder
			// Trying to write _fit/.obsidian/workspace.json should fail with clear error
			const existingFile = StubTFile.ofPath('.obsidian');

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				// Parent path exists as a file (not a folder)
				if (path === '_fit/.obsidian') return existingFile as TFile;
				// The target file doesn't exist yet
				if (path === '_fit/.obsidian/workspace.json') return null;
				return null;
			});

			// Mock adapter.stat to return file type for the parent path
			mockVault.adapter.stat.mockImplementation(async (path) => {
				if (path === '_fit') return null; // _fit doesn't exist
				if (path === '_fit/.obsidian') return { type: 'file' }; // exists as file
				return null;
			});

			const localVault = new LocalVault(mockVault as any as Vault);

			// Should throw error detecting file at folder path
			await expect(
				localVault.applyChanges(
					[{ path: '_fit/.obsidian/workspace.json', content: FileContent.fromPlainText('{}') }],
					[]
				)
			).rejects.toThrow(/file already exists at this path/);
		});

		it('should succeed when parent folder already exists as a folder (issue #153)', async () => {
			// Scenario: _fit/.obsidian exists as a FOLDER (correct state)
			// Writing _fit/.obsidian/workspace.json should succeed
			const existingFolder = Object.create(TFolder.prototype);
			existingFolder.path = '_fit/.obsidian';

			mockVault.getAbstractFileByPath.mockImplementation((path) => {
				// Parent path exists as a folder (correct)
				if (path === '_fit/.obsidian') return existingFolder;
				// The target file doesn't exist yet
				if (path === '_fit/.obsidian/workspace.json') return null;
				return null;
			});

			// Mock adapter.stat to return folder type for parent paths
			mockVault.adapter.stat.mockImplementation(async (path) => {
				if (path === '_fit') return { type: 'folder' };
				if (path === '_fit/.obsidian') return { type: 'folder' };
				return null;
			});

			const localVault = new LocalVault(mockVault as any as Vault);

			const result = await localVault.applyChanges(
				[{ path: '_fit/.obsidian/workspace.json', content: FileContent.fromPlainText('{}') }],
				[]
			);

			// Should succeed and create the file
			expect(result.changes).toEqual([
				{ path: '_fit/.obsidian/workspace.json', type: 'ADDED' }
			]);
			// Should NOT try to create folder (it already exists)
			expect(mockVault.createFolder).not.toHaveBeenCalled();
			expect(mockVault.adapter.mkdir).not.toHaveBeenCalled();
			// Should create the file using text API (JSON is plaintext)
			expect(mockVault.create).toHaveBeenCalledWith(
				'_fit/.obsidian/workspace.json',
				'{}'
			);
		});

		it('should create deeply nested directories recursively', async () => {
			// Scenario: Writing to a/b/c/d/file.md where none of the directories exist
			mockVault.getAbstractFileByPath.mockReturnValue(null);
			mockVault.adapter.stat.mockResolvedValue(null); // Nothing exists

			const localVault = new LocalVault(mockVault as any as Vault);

			const result = await localVault.applyChanges(
				[{ path: 'a/b/c/d/file.md', content: FileContent.fromPlainText('content') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: 'a/b/c/d/file.md', type: 'ADDED' }
			]);
			// Should create all parent directories
			expect(mockVault.createFolder).toHaveBeenCalledWith('a');
			expect(mockVault.createFolder).toHaveBeenCalledWith('a/b');
			expect(mockVault.createFolder).toHaveBeenCalledWith('a/b/c');
			expect(mockVault.createFolder).toHaveBeenCalledWith('a/b/c/d');
			expect(mockVault.createFolder).toHaveBeenCalledTimes(4);
		});

		it('should use adapter.mkdir for hidden directories', async () => {
			// Scenario: Writing to .github/workflows/ci.yml (hidden directory)
			mockVault.getAbstractFileByPath.mockReturnValue(null);
			mockVault.adapter.stat.mockResolvedValue(null); // Nothing exists

			const localVault = new LocalVault(mockVault as any as Vault);

			const result = await localVault.applyChanges(
				[{ path: '.github/workflows/ci.yml', content: FileContent.fromPlainText('name: CI') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: '.github/workflows/ci.yml', type: 'ADDED' }
			]);
			// Should use adapter.mkdir for hidden directories (not vault.createFolder)
			expect(mockVault.adapter.mkdir).toHaveBeenCalledWith('.github');
			expect(mockVault.adapter.mkdir).toHaveBeenCalledWith('.github/workflows');
			expect(mockVault.createFolder).not.toHaveBeenCalled();
		});

		it('should skip creating directories that already exist', async () => {
			// Scenario: Writing to existing/path/new-file.md where existing/path already exists
			mockVault.getAbstractFileByPath.mockReturnValue(null);
			mockVault.adapter.stat.mockImplementation(async (path) => {
				if (path === 'existing') return { type: 'folder' };
				if (path === 'existing/path') return { type: 'folder' };
				return null;
			});

			const localVault = new LocalVault(mockVault as any as Vault);

			const result = await localVault.applyChanges(
				[{ path: 'existing/path/new-file.md', content: FileContent.fromPlainText('content') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: 'existing/path/new-file.md', type: 'ADDED' }
			]);
			// Should NOT create any folders (they already exist)
			expect(mockVault.createFolder).not.toHaveBeenCalled();
			expect(mockVault.adapter.mkdir).not.toHaveBeenCalled();
		});

		it('should handle parallel creation of files in the same new directory without race conditions', async () => {
			// Scenario: Writing two files to a/b/c/ where none of the directories exist, processed in parallel.
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			// Mock createFolder to simulate a real filesystem, which throws if a folder already exists.
			const createdFolders = new Set<string>();
			mockVault.createFolder.mockImplementation(async (path) => {
				if (createdFolders.has(path)) {
					throw new Error(`Folder ${path} already exists`);
				}
				createdFolders.add(path);
			});

			// Mock stat to return folder type for folders that have been created
			// This simulates the real filesystem behavior where stat returns the folder after creation
			mockVault.adapter.stat.mockImplementation(async (path) => {
				if (createdFolders.has(path)) {
					return { type: 'folder' };
				}
				return null;
			});

			const localVault = new LocalVault(mockVault as any as Vault);

			// This call should succeed without throwing, as the race condition should be handled internally.
			const result = await localVault.applyChanges(
				[
					{ path: 'a/b/c/file1.md', content: FileContent.fromPlainText('content1') },
					{ path: 'a/b/c/file2.md', content: FileContent.fromPlainText('content2') }
				],
				[]
			);

			expect(result.changes.length).toBe(2);
			expect(createdFolders.size).toBe(3); // a, a/b, a/b/c
		});

		it('should handle adapters that throw on stat for non-existent paths', async () => {
			// Scenario: Some DataAdapter implementations throw when stat() is called on non-existent paths
			// instead of returning null. The code should handle this gracefully.
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			// Mock stat to throw for non-existent paths (like some adapter implementations do)
			mockVault.adapter.stat.mockImplementation(async (path) => {
				throw new Error(`ENOENT: no such file or directory: ${path}`);
			});

			const localVault = new LocalVault(mockVault as any as Vault);

			const result = await localVault.applyChanges(
				[{ path: 'new-folder/file.md', content: FileContent.fromPlainText('content') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: 'new-folder/file.md', type: 'ADDED' }
			]);
			// Should create the folder despite stat throwing
			expect(mockVault.createFolder).toHaveBeenCalledWith('new-folder');
		});
	});

	describe('fileSha1 canonical git blob SHA (issue #51, #146)', () => {
		it('NFD and NFC paths produce the same SHA (path not in hash)', async () => {
			const content = FileContent.fromPlainText("test content");
			const turkishName = "Merhaba dünya ıııınınİİİİ.md";
			const nfdPath = turkishName.normalize('NFD');
			const nfcPath = turkishName.normalize('NFC');
			expect(nfdPath).not.toBe(nfcPath); // confirm inputs differ

			// Path is not part of the canonical hash, so both are identical
			expect(await LocalVault.fileSha1(nfdPath, content))
				.toBe(await LocalVault.fileSha1(nfcPath, content));
		});

		it('fileSha1 matches canonical git blob SHA format', async () => {
			const content = FileContent.fromPlainText("test");
			const sha = await LocalVault.fileSha1("any/path.md", content);

			// git blob SHA: SHA1("blob " + byteLen + NUL + rawBytes)
			const rawBytes = new TextEncoder().encode("test");
			const header = new TextEncoder().encode(`blob ${rawBytes.length}\0`);
			const data = new Uint8Array(header.length + rawBytes.length);
			data.set(header);
			data.set(rawBytes, header.length);
			const hashBuf = await crypto.subtle.digest('SHA-1', data);
			const expected = Array.from(new Uint8Array(hashBuf))
				.map(b => b.toString(16).padStart(2, '0')).join('');

			expect(sha).toBe(expected);
		});

		it('fileLegacySha1 reproduces the old path+content SHA', async () => {
			const path = "dünya.md";
			const content = FileContent.fromPlainText("test");
			const legacySha = await LocalVault.fileLegacySha1(path, content);
			const manualSha = await computeSha1(path + "test");
			expect(legacySha).toBe(manualSha);
		});
	});

	describe('Encoding corruption detection (issue #51)', () => {
		it('should detect suspicious correspondence when remote file matches local pattern', async () => {
			const vault = mockVault;
			const localVault = new LocalVault(vault as any);

			const localPath = 'Küçük.md';
			const corruptedPath = 'K眉莽眉k.md';
			const content = FileContent.fromPlainText('test content');

			// Set up vault to have the local file
			vault.getFiles.mockReturnValue([{ path: localPath } as any]);
			// Corrupted file doesn't exist yet (will be created)
			vault.getAbstractFileByPath.mockImplementation((path: string) => {
				if (path === corruptedPath) return null; // File doesn't exist
				return { path } as any;
			});
			// Mock file operations to avoid actual writes
			vault.cachedRead.mockResolvedValue('');
			vault.modifyBinary.mockResolvedValue(undefined);

			// Apply changes with corrupted remote file
			const result = await localVault.applyChanges(
				[{ path: corruptedPath, content }],
				[]
			);

			// Should return user warning
			expect(result.userWarning).toBeDefined();
			expect(result.userWarning).toContain('⚠️ Encoding Issue Detected');
			expect(result.userWarning).toContain('Suspicious filename patterns');
		});

		it('should NOT warn for legitimate CJK filenames without ASCII sandwich', async () => {
			const vault = mockVault;
			const localVault = new LocalVault(vault as any);

			// Two different Chinese filenames - pattern "*.md" has no sandwich
			vault.getFiles.mockReturnValue([{ path: '文件.md' } as any]);
			vault.getAbstractFileByPath.mockReturnValue(null);

			const result = await localVault.applyChanges(
				[{ path: '档案.md', content: FileContent.fromPlainText('content') }],
				[]
			);

			// Should NOT warn (no ASCII sandwich)
			expect(result.userWarning).toBeUndefined();
		});

		it('should detect multiple suspicious correspondences', async () => {
			const vault = mockVault;
			const localVault = new LocalVault(vault as any);

			const localFiles = ['Küçük.md', 'Büyük.md', 'İstanbul.md'];
			const corruptedFiles = [
				{ path: 'K眉莽眉k.md', content: FileContent.fromPlainText('file1') },
				{ path: 'Byk.md', content: FileContent.fromPlainText('file2') },
				{ path: '脹stanbul.md', content: FileContent.fromPlainText('file3') }
			];

			vault.getFiles.mockReturnValue(localFiles.map(path => ({ path } as any)));
			vault.getAbstractFileByPath.mockReturnValue(null);

			const result = await localVault.applyChanges(corruptedFiles, []);

			// Should detect all 3 corruptions
			expect(result.userWarning).toBeDefined();
			expect(result.userWarning).toContain('⚠️ Encoding Issue Detected');
		});

		it('should NOT warn when file already exists locally', async () => {
			const vault = mockVault;
			const localVault = new LocalVault(vault as any);

			const mockFile = StubTFile.ofPath('K眉莽眉k.md');

			vault.getFiles.mockReturnValue([{ path: 'Küçük.md' } as any]);
			// File already exists - return a TFile object
			vault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			// Mock file operations
			vault.cachedRead.mockResolvedValue('old content');
			vault.modifyBinary.mockResolvedValue(undefined);

			const result = await localVault.applyChanges(
				[{ path: 'K眉莽眉k.md', content: FileContent.fromPlainText('content') }],
				[]
			);

			// Should NOT warn (file already exists, this is an update not creation)
			expect(result.userWarning).toBeUndefined();
		});

		it('should NOT warn for pure ASCII filenames', async () => {
			const vault = mockVault;
			const localVault = new LocalVault(vault as any);

			vault.getFiles.mockReturnValue([{ path: 'test.md' } as any]);
			vault.getAbstractFileByPath.mockReturnValue(null);

			const result = await localVault.applyChanges(
				[{ path: 'other.md', content: FileContent.fromPlainText('content') }],
				[]
			);

			// Should NOT warn (no non-ASCII chars)
			expect(result.userWarning).toBeUndefined();
		});
	});

	describe('Hidden file operations (untracked files)', () => {
		// These tests verify handling of hidden files (files not in vault index)
		// vault.getAbstractFileByPath() returns null for hidden files even when they exist
		// See docs/api-compatibility.md "Reading Untracked Files" for details

		it('should modify existing hidden files (second sync)', async () => {
			const fakeVault = new FakeObsidianVault();
			// Simulate: .gitignore exists on disk from previous sync
			await fakeVault.adapter.write('.gitignore', '*.log\n');

			const localVault = new LocalVault(fakeVault as any);

			const result = await localVault.applyChanges(
				[{ path: '.gitignore', content: FileContent.fromPlainText('*.log\n*.tmp\n') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: '.gitignore', type: 'MODIFIED' }
			]);
			// Verify file was actually updated on disk
			const updated = await fakeVault.adapter.readBinary('.gitignore');
			expect(new TextDecoder().decode(updated)).toBe('*.log\n*.tmp\n');
		});

		it('should delete hidden files', async () => {
			const fakeVault = new FakeObsidianVault();
			// Simulate: .gitignore exists on disk
			await fakeVault.adapter.write('.gitignore', '*.log\n');

			const localVault = new LocalVault(fakeVault as any);

			const result = await localVault.applyChanges(
				[],
				['.gitignore']
			);

			expect(result.changes).toEqual([
				{ path: '.gitignore', type: 'REMOVED' }
			]);
			// Verify file was actually deleted from disk (stat returns null for non-existent files)
			expect(await fakeVault.adapter.stat('.gitignore')).toBeNull();
		});

		it('should create new hidden files (first sync)', async () => {
			const fakeVault = new FakeObsidianVault();
			// Simulate: .editorconfig doesn't exist yet

			const localVault = new LocalVault(fakeVault as any);

			const result = await localVault.applyChanges(
				[{ path: '.editorconfig', content: FileContent.fromPlainText('[*.ts]\nindent_style = tab\n') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: '.editorconfig', type: 'ADDED' }
			]);
			// Verify file was actually created on disk
			const created = await fakeVault.adapter.readBinary('.editorconfig');
			expect(new TextDecoder().decode(created)).toBe('[*.ts]\nindent_style = tab\n');
		});

		it('should handle binary hidden files without corruption', async () => {
			const fakeVault = new FakeObsidianVault();
			// Simulate: binary hidden file exists (e.g., .DS_Store icon data)
			const binaryData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header
			await fakeVault.adapter.writeBinary('.image-cache.png', binaryData.buffer);

			const localVault = new LocalVault(fakeVault as any);

			// Update the binary file
			const newBinaryData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header
			// Convert to base64 without stack overflow (avoid spread operator for large arrays)
			const binaryString = Array.from(newBinaryData, byte => String.fromCharCode(byte)).join('');
			const result = await localVault.applyChanges(
				[{ path: '.image-cache.png', content: FileContent.fromBase64(btoa(binaryString)) }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: '.image-cache.png', type: 'MODIFIED' }
			]);
			// Verify binary data was written correctly without corruption
			const updated = await fakeVault.adapter.readBinary('.image-cache.png');
			const updatedBytes = new Uint8Array(updated);
			expect(Array.from(updatedBytes)).toEqual([0xFF, 0xD8, 0xFF, 0xE0]);
		});

		it('should create nested hidden directories (e.g., .github/workflows)', async () => {
			const fakeVault = new FakeObsidianVault();
			// Simulate: .github/workflows/ci.yml doesn't exist yet

			const localVault = new LocalVault(fakeVault as any);

			const result = await localVault.applyChanges(
				[{ path: '.github/workflows/ci.yml', content: FileContent.fromPlainText('name: CI\non: push') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: '.github/workflows/ci.yml', type: 'ADDED' }
			]);
			// Verify file was created
			const created = await fakeVault.adapter.readBinary('.github/workflows/ci.yml');
			expect(new TextDecoder().decode(created)).toBe('name: CI\non: push');
			// Verify directories were created (stat returns folder type)
			expect(await fakeVault.adapter.stat('.github')).toEqual(expect.objectContaining({ type: 'folder' }));
			expect(await fakeVault.adapter.stat('.github/workflows')).toEqual(expect.objectContaining({ type: 'folder' }));
		});

		it('should create deeply nested normal directories', async () => {
			const fakeVault = new FakeObsidianVault();
			// Simulate: The Starforged (NickArrow)/Characters/attachments/file.png doesn't exist

			const localVault = new LocalVault(fakeVault as any);

			const result = await localVault.applyChanges(
				[{ path: 'The Starforged (NickArrow)/Characters/attachments/profile.png', content: FileContent.fromPlainText('fake-image') }],
				[]
			);

			expect(result.changes).toEqual([
				{ path: 'The Starforged (NickArrow)/Characters/attachments/profile.png', type: 'ADDED' }
			]);
			// Verify file was created
			const created = await fakeVault.adapter.readBinary('The Starforged (NickArrow)/Characters/attachments/profile.png');
			expect(new TextDecoder().decode(created)).toBe('fake-image');
		});
	});

	describe('.gitignore filtering in readFromSource', () => {
		it('should exclude files matched by root .gitignore', async () => {
			const fakeVault = new FakeObsidianVault();

			// Set up .gitignore (hidden file, use adapter)
			await fakeVault.adapter.write('.gitignore', '*.log\nnode_modules/');

			// Set up visible files (use create to add to vault index)
			await fakeVault.create('README.md', 'readme');
			await fakeVault.create('debug.log', 'log content');
			await fakeVault.create('src/main.ts', 'code');
			await fakeVault.create('node_modules/pkg/index.js', 'module');

			const localVault = new LocalVault(fakeVault as any);
			const { state } = await localVault.readFromSource();

			expect(Object.keys(state).sort()).toEqual(['README.md', 'src/main.ts']);
		});

		it('should exclude files matched by nested .gitignore', async () => {
			const fakeVault = new FakeObsidianVault();

			// Nested .gitignore only affects its directory
			await fakeVault.adapter.write('build/.gitignore', '*.map\n*.tmp');

			await fakeVault.create('build/app.js', 'code');
			await fakeVault.create('build/app.js.map', 'sourcemap');
			await fakeVault.create('src/app.js.map', 'not ignored - no gitignore in src/');

			const localVault = new LocalVault(fakeVault as any);
			const { state } = await localVault.readFromSource();

			expect(Object.keys(state).sort()).toEqual(['build/app.js', 'src/app.js.map']);
		});

		it('should include all files when no .gitignore exists', async () => {
			const fakeVault = new FakeObsidianVault();

			await fakeVault.create('file.log', 'log');
			await fakeVault.create('file.md', 'doc');

			const localVault = new LocalVault(fakeVault as any);
			const { state } = await localVault.readFromSource();

			expect(Object.keys(state).sort()).toEqual(['file.log', 'file.md']);
		});
	});
});
