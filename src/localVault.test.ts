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
import { TFile, Vault } from 'obsidian';
import { StubTFile } from './testUtils';
import { FileContent } from './util/contentEncoding';
import { arrayBufferToContent } from './util/obsidianHelpers';

// Type-safe mock that includes only the methods LocalVault uses
type MockVault = Pick<Vault,
	'getFiles' | 'getAbstractFileByPath' | 'createFolder' |
	'read' | 'readBinary' | 'cachedRead' | 'createBinary' | 'modifyBinary' | 'delete'
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
			createBinary: vi.fn(),
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
			mockVault.read.mockImplementation(async (file: TFile) => {
				if (file.path === 'note1.md') return 'Content of note 1';
				if (file.path === 'note2.txt') return 'Content of note 2';
				return '';
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
			mockVault.read.mockResolvedValue('file content');
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
			mockVault.readBinary.mockResolvedValue(new ArrayBuffer(8));
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
			expect(state['doc.pdf']).toMatchInlineSnapshot(
				`"acf8daf266d952b03fb02280dc5c92d8e4e51ad7"`);
			expect(state['image.png']).toMatchInlineSnapshot(
				`"fe954d839c04f84471b6dd90c945e55a6035de80"`);
			expect(state['archive.zip']).toMatchInlineSnapshot(
				`"e67146506d2b18d3414a28ddc204c9dda6267080"`);
		});

		it('should handle empty vault', async () => {
			mockVault.getFiles.mockReturnValue([]);

			const localVault = new LocalVault(mockVault as any as Vault);
			const { state } = await localVault.readFromSource();

			expect(state).toEqual({});
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

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.read.mockResolvedValue(expectedContent);

			const localVault = new LocalVault(mockVault as any as Vault);
			const content = await localVault.readFileContent('note.md');

			expect(content).toEqual(FileContent.fromPlainText(expectedContent));
			expect(mockVault.read).toHaveBeenCalledWith(mockFile);
		});

		it('should read binary file content as base64', async () => {
			const mockFile = StubTFile.ofPath('image.png');
			const binaryData = new ArrayBuffer(8);

			mockVault.getAbstractFileByPath.mockReturnValue(mockFile as TFile);
			mockVault.readBinary.mockResolvedValue(binaryData);

			const localVault = new LocalVault(mockVault as any as Vault);
			const content = await localVault.readFileContent('image.png');

			expect(content).toEqual(FileContent.fromBase64(arrayBufferToContent(binaryData)));
			expect(mockVault.readBinary).toHaveBeenCalledWith(mockFile);
		});

		it('should throw error if file not found', async () => {
			mockVault.getAbstractFileByPath.mockReturnValue(null);

			const localVault = new LocalVault(mockVault as any as Vault);

			await expect(localVault.readFileContent('missing.md')).rejects.toThrow(
				'File not found: missing.md'
			);
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
			mockVault.modifyBinary = vi.fn().mockImplementation(async () => {
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
	});
});
