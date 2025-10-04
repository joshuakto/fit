/**
 * Tests for LocalVault
 *
 * Covers:
 * - Path filtering (ignored paths)
 * - State computation
 * - Change detection
 */

import { LocalVault } from './localVault';
import { VaultOperations } from './vaultOps';
import { TFile, Vault } from 'obsidian';
import { FileState } from './vault';
import { StubTFile } from './testUtils';

describe('LocalVault', () => {
	let mockVault: jest.Mocked<Vault>;
	let vaultOps: VaultOperations;

	beforeEach(() => {
		mockVault = {
			getFiles: jest.fn(),
			read: jest.fn(),
			readBinary: jest.fn(),
			getAbstractFileByPath: jest.fn()
		} as unknown as jest.Mocked<Vault>;

		vaultOps = new VaultOperations(mockVault);
	});

	describe('shouldTrackState', () => {
		it('should exclude hidden files (starting with .)', () => {
			const localVault = new LocalVault(vaultOps);

			expect(localVault.shouldTrackState('.obsidian/config.json')).toBe(false);
			expect(localVault.shouldTrackState('.gitignore')).toBe(false);
			expect(localVault.shouldTrackState('.DS_Store')).toBe(false);
		});

		it('should exclude files in hidden directories', () => {
			const localVault = new LocalVault(vaultOps);

			expect(localVault.shouldTrackState('.obsidian/plugins/fit/main.js')).toBe(false);
			expect(localVault.shouldTrackState('folder/.hidden/file.md')).toBe(false);
		});

		it('should track normal files', () => {
			const localVault = new LocalVault(vaultOps);

			expect(localVault.shouldTrackState('notes/daily/2024-01-01.md')).toBe(true);
			expect(localVault.shouldTrackState('README.md')).toBe(true);
			expect(localVault.shouldTrackState('fit_documentation.md')).toBe(true); // "fit" in name is OK
		});

		it('should handle edge cases', () => {
			const localVault = new LocalVault(vaultOps);

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

			const localVault = new LocalVault(vaultOps);
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

			const localVault = new LocalVault(vaultOps);
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

			const localVault = new LocalVault(vaultOps);
			const state = await localVault.computeCurrentState();

			expect(Object.keys(state).sort()).toEqual(['doc.pdf', 'image.png']);
		});

		it('should handle empty vault', async () => {
			mockVault.getFiles.mockReturnValue([]);

			const localVault = new LocalVault(vaultOps);
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

			const localVault = new LocalVault(vaultOps);
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

			const localVault = new LocalVault(vaultOps);
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

			const localVault = new LocalVault(vaultOps);
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

			const localVault = new LocalVault(vaultOps);
			const currentState = await localVault.computeCurrentState();

			// Use same state as baseline
			const changes = await localVault.getChanges(currentState);

			expect(changes).toHaveLength(0);
		});
	});

	describe('baseline state management', () => {
		it('should update baseline state', () => {
			const localVault = new LocalVault(vaultOps, {});
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

			const localVault = new LocalVault(vaultOps, initialBaseline);
			const retrievedState = localVault.getBaselineState();

			expect(retrievedState).toEqual(initialBaseline);
		});

		it('should return copy of baseline state (not reference)', () => {
			const initialBaseline: FileState = {
				'file.md': 'sha'
			};

			const localVault = new LocalVault(vaultOps, initialBaseline);
			const state1 = localVault.getBaselineState();
			const state2 = localVault.getBaselineState();

			// Modify one copy
			state1['modified.md'] = 'new_sha';

			// Other copy should be unaffected
			expect(state2).not.toHaveProperty('modified.md');
			expect(localVault.getBaselineState()).toEqual(initialBaseline);
		});
	});
});
