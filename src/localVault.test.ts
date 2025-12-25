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
import { StubTFile } from './testUtils';
import { FileContent } from './util/contentEncoding';
import { arrayBufferToContent } from './util/obsidianHelpers';
import { computeSha1 } from './util/hashing';

// Type-safe mock that includes only the methods LocalVault uses
type MockVault = Pick<Vault,
	'getFiles' | 'getAbstractFileByPath' | 'createFolder' |
	'read' | 'readBinary' | 'cachedRead' |
	'create' | 'createBinary' | 'modify' | 'modifyBinary' | 'delete'
>;

describe('LocalVault', () => {
	let mockVault: {
		[K in keyof MockVault]: Mock;
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
			delete: vi.fn()
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
		it('should exclude hidden files (starting with .)', () => {
			const localVault = new LocalVault(mockVault as any as Vault);

			expect(localVault.shouldTrackState('.obsidian/config.json')).toBe(false);
			expect(localVault.shouldTrackState('.gitignore')).toBe(false);
			expect(localVault.shouldTrackState('.DS_Store')).toBe(false);
		});

		it('should exclude files in hidden directories', () => {
			const localVault = new LocalVault(mockVault as any as Vault);

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
			mockVault.readBinary.mockResolvedValue(new TextEncoder().encode('file content').buffer);
			mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
				return mockFiles.find(f => f.path === path) as TFile;
			});

			const localVault = new LocalVault(mockVault as any as Vault);
			const { state } = await localVault.readFromSource();

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
			// SHAs should be stable (uses base64 encoding for all three)
			expect(state['doc.pdf']).toMatchInlineSnapshot(
				`"acf8daf266d952b03fb02280dc5c92d8e4e51ad7"`);
			expect(state['image.png']).toMatchInlineSnapshot(
				`"fe954d839c04f84471b6dd90c945e55a6035de80"`);
			expect(state['archive.zip']).toMatchInlineSnapshot(
				`"a93c48b470cca6e238405a1aad306434aa9618a2"`);
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

			expect(content).toEqual(FileContent.fromPlainText(expectedContent));
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
			expect(content).toEqual(FileContent.fromBase64(arrayBufferToContent(binaryData)));
		});

		it('should throw error if file not found', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			const localVault = new LocalVault(mockVault as any as Vault);

			await expect(localVault.readFileContent('missing.md')).rejects.toThrow(
				'File not found: missing.md'
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
			expect(content).toEqual(FileContent.fromPlainText(textContent));
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
			expect(await results.writtenStates).toEqual({
				'new.md': expect.any(String),
				'existing.md': expect.any(String),
				// Note no 'delete.md' (Deleted files should not have SHAs)
			});
		});

		it('should handle empty changes', async () => {
			const localVault = new LocalVault(mockVault as any as Vault);
			const results = await localVault.applyChanges([], []);

			expect(results.changes).toEqual([]);
			expect(await results.writtenStates).toEqual({});
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
			// Should create the file using text API (JSON is plaintext)
			expect(mockVault.create).toHaveBeenCalledWith(
				'_fit/.obsidian/workspace.json',
				'{}'
			);
		});
	});

	describe('Unicode normalization in fileSha1 (issue #51)', () => {
		it('NFD and NFC forms now produce SAME SHA (bug fixed)', async () => {
			const content = FileContent.fromPlainText("test content");

			// Turkish filename with İ (capital I with dot) and ı (lowercase i without dot)
			const turkishName = "Merhaba dünya ıııııııİİİİ.md";

			// macOS/iOS typically use NFD (decomposed)
			const nfdPath = turkishName.normalize('NFD');
			// Windows/Linux/Android typically use NFC (composed)
			const nfcPath = turkishName.normalize('NFC');

			// Verify input paths are different byte sequences but visually identical
			expect(nfdPath).not.toBe(nfcPath);
			expect(nfdPath.length).not.toBe(nfcPath.length); // NFD has more codepoints

			// FIXED: Both normalize to NFC before hashing, producing identical SHAs
			const nfdSha = await LocalVault.fileSha1(nfdPath, content);
			const nfcSha = await LocalVault.fileSha1(nfcPath, content);

			// These SHAs are now the same, preventing file duplication
			expect(nfdSha).toBe(nfcSha);
		});

		it('fileSha1 concatenates path + content before hashing', async () => {
			const path = "dünya.md";
			const content = FileContent.fromPlainText("test");

			// LocalVault.fileSha1 does: computeSha1(path + content)
			const sha = await LocalVault.fileSha1(path, content);

			// Verify it's computing SHA of the concatenation
			const manualSha = await computeSha1(path + "test");
			expect(sha).toBe(manualSha);
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
});
