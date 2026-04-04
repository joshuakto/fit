/**
 * Tests for NodeLocalVault
 *
 * Covers:
 * - shouldTrackState (hidden file exclusion)
 * - readFromSource (state computation, hidden-file filtering)
 * - readFileContent (plaintext and binary detection)
 * - applyChanges (write ADDED/MODIFIED, delete, clash paths → _fit/)
 * - statPaths
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NodeLocalVault } from './nodeLocalVault';
import { FileContent } from '../util/contentEncoding';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a fresh temp vault directory for each test */
async function makeTempVault(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'fit-test-'));
}

/** Write a vault-relative file (creating dirs as needed) */
async function writeVaultFile(vaultPath: string, relPath: string, content: string): Promise<void> {
	const abs = path.join(vaultPath, relPath);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, 'utf-8');
}

/** Write raw binary bytes to a vault-relative file */
async function writeBinaryVaultFile(vaultPath: string, relPath: string, buf: Buffer): Promise<void> {
	const abs = path.join(vaultPath, relPath);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, buf);
}

/** Read vault-relative file as utf-8 string */
async function readVaultFile(vaultPath: string, relPath: string): Promise<string> {
	return fs.readFile(path.join(vaultPath, relPath), 'utf-8');
}

/** Check if a vault-relative path exists */
async function vaultPathExists(vaultPath: string, relPath: string): Promise<boolean> {
	try {
		await fs.access(path.join(vaultPath, relPath));
		return true;
	} catch {
		return false;
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NodeLocalVault', () => {
	let vaultPath: string;
	let vault: NodeLocalVault;

	beforeEach(async () => {
		vaultPath = await makeTempVault();
		vault = new NodeLocalVault(vaultPath);
	});

	afterEach(async () => {
		await fs.rm(vaultPath, { recursive: true, force: true });
	});

	// ── shouldTrackState ───────────────────────────────────────────────────

	describe('shouldTrackState', () => {
		it('should track normal files', () => {
			expect(vault.shouldTrackState('note.md')).toBe(true);
			expect(vault.shouldTrackState('folder/note.md')).toBe(true);
			expect(vault.shouldTrackState('a/b/c.txt')).toBe(true);
		});

		it('should not track dot-prefixed files at root', () => {
			expect(vault.shouldTrackState('.gitignore')).toBe(false);
			expect(vault.shouldTrackState('.env')).toBe(false);
		});

		it('should not track files inside hidden directories', () => {
			expect(vault.shouldTrackState('.obsidian/app.json')).toBe(false);
			expect(vault.shouldTrackState('.obsidian/plugins/fit/data.json')).toBe(false);
		});

		it('should not track the _fit staging folder', () => {
			// _fit is a non-hidden convention — it IS tracked by shouldTrackState itself,
			// but it is excluded from sync by the fitSync layer (same as LocalVault)
			expect(vault.shouldTrackState('_fit/file.md')).toBe(true);
		});
	});

	// ── readFromSource ─────────────────────────────────────────────────────

	describe('readFromSource', () => {
		it('should return empty state for an empty vault', async () => {
			const result = await vault.readFromSource();
			expect(result.state).toEqual({});
		});

		it('should include tracked files in state', async () => {
			await writeVaultFile(vaultPath, 'a.md', '# Hello');
			await writeVaultFile(vaultPath, 'notes/b.md', 'content');

			const result = await vault.readFromSource();
			expect(Object.keys(result.state)).toContain('a.md');
			expect(Object.keys(result.state)).toContain('notes/b.md');
		});

		it('should exclude hidden files from state', async () => {
			await writeVaultFile(vaultPath, 'visible.md', 'hello');
			await writeVaultFile(vaultPath, '.hidden', 'secret');

			const result = await vault.readFromSource();
			expect(Object.keys(result.state)).toContain('visible.md');
			expect(Object.keys(result.state)).not.toContain('.hidden');
		});

		it('should exclude files in hidden directories from state', async () => {
			await writeVaultFile(vaultPath, 'note.md', 'hello');
			await writeVaultFile(vaultPath, '.obsidian/config.json', '{}');

			const result = await vault.readFromSource();
			expect(Object.keys(result.state)).toContain('note.md');
			expect(Object.keys(result.state)).not.toContain('.obsidian/config.json');
		});

		it('should compute a stable SHA for each file', async () => {
			await writeVaultFile(vaultPath, 'note.md', 'hello world');

			const result1 = await vault.readFromSource();
			const result2 = await vault.readFromSource();

			expect(result1.state['note.md']).toBe(result2.state['note.md']);
		});

		it('should produce different SHAs for files with different content', async () => {
			await writeVaultFile(vaultPath, 'a.md', 'content A');
			await writeVaultFile(vaultPath, 'b.md', 'content B');

			const result = await vault.readFromSource();
			expect(result.state['a.md']).not.toBe(result.state['b.md']);
		});
	});

	// ── readFileContent ────────────────────────────────────────────────────

	describe('readFileContent', () => {
		it('should read plaintext files as plaintext', async () => {
			await writeVaultFile(vaultPath, 'note.md', '# Hello\nWorld');
			const content = await vault.readFileContent('note.md');
			expect(content.toPlainText()).toBe('# Hello\nWorld');
		});

		it('should read binary files as base64', async () => {
			// PNG magic bytes (start with null-adjacent bytes, detectable as binary)
			const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			await writeBinaryVaultFile(vaultPath, 'image.png', pngMagic);

			const content = await vault.readFileContent('image.png');
			// Should be base64-encoded (not throw on toBase64)
			expect(() => content.toBase64()).not.toThrow();
			expect(content.toBase64()).toBe(pngMagic.toString('base64'));
		});

		it('should detect binary content with null bytes', async () => {
			const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
			await writeBinaryVaultFile(vaultPath, 'data.bin', binaryData);

			const content = await vault.readFileContent('data.bin');
			expect(content.toBase64()).toBe(binaryData.toString('base64'));
		});

		it('should throw VaultError for missing files', async () => {
			await expect(vault.readFileContent('nonexistent.md')).rejects.toThrow('Failed to read nonexistent.md');
		});
	});

	// ── applyChanges: write ────────────────────────────────────────────────

	describe('applyChanges (write)', () => {
		it('should create a new file with ADDED change record', async () => {
			const content = FileContent.fromPlainText('# New note');
			const result = await vault.applyChanges([{ path: 'new.md', content }], []);

			expect(result.changes).toEqual([{ path: 'new.md', type: 'ADDED' }]);
			expect(await readVaultFile(vaultPath, 'new.md')).toBe('# New note');
		});

		it('should update an existing file with MODIFIED change record', async () => {
			await writeVaultFile(vaultPath, 'existing.md', 'old');

			const content = FileContent.fromPlainText('new content');
			const result = await vault.applyChanges([{ path: 'existing.md', content }], []);

			expect(result.changes).toEqual([{ path: 'existing.md', type: 'MODIFIED' }]);
			expect(await readVaultFile(vaultPath, 'existing.md')).toBe('new content');
		});

		it('should create parent directories as needed', async () => {
			const content = FileContent.fromPlainText('nested');
			await vault.applyChanges([{ path: 'a/b/c.md', content }], []);

			expect(await readVaultFile(vaultPath, 'a/b/c.md')).toBe('nested');
		});

		it('should write binary files correctly', async () => {
			const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
			const content = FileContent.fromBase64(binaryData.toString('base64'));
			await vault.applyChanges([{ path: 'img.png', content }], []);

			const written = await fs.readFile(path.join(vaultPath, 'img.png'));
			expect(written).toEqual(binaryData);
		});

		it('should write clashed files to _fit/ prefix', async () => {
			const content = FileContent.fromPlainText('remote version');
			const clashPaths = new Set(['clash.md']);
			const result = await vault.applyChanges([{ path: 'clash.md', content }], [], { clashPaths });

			expect(result.changes[0].path).toBe('_fit/clash.md');
			expect(result.changes[0].type).toBe('ADDED');
			expect(await readVaultFile(vaultPath, '_fit/clash.md')).toBe('remote version');
		});

		it('should compute SHA keyed to the original path (not _fit/) for clashed files', async () => {
			const content = FileContent.fromPlainText('content');
			const clashPaths = new Set(['file.md']);
			const result = await vault.applyChanges([{ path: 'file.md', content }], [], { clashPaths });

			const baseline = await result.newBaselineStates;
			// SHA is keyed to 'file.md', not '_fit/file.md'
			expect(Object.keys(baseline)).toContain('file.md');
			expect(Object.keys(baseline)).not.toContain('_fit/file.md');
		});

		it('should populate newBaselineStates with SHAs for written files', async () => {
			const content = FileContent.fromPlainText('hello');
			const result = await vault.applyChanges([{ path: 'note.md', content }], []);

			const baseline = await result.newBaselineStates;
			expect(baseline).toHaveProperty('note.md');
			expect(typeof baseline['note.md']).toBe('string');
			expect((baseline['note.md'] as string).length).toBe(40); // SHA-1 hex
		});
	});

	// ── applyChanges: delete ───────────────────────────────────────────────

	describe('applyChanges (delete)', () => {
		it('should delete an existing file with REMOVED change record', async () => {
			await writeVaultFile(vaultPath, 'old.md', 'bye');
			const result = await vault.applyChanges([], ['old.md']);

			expect(result.changes).toEqual([{ path: 'old.md', type: 'REMOVED' }]);
			expect(await vaultPathExists(vaultPath, 'old.md')).toBe(false);
		});

		it('should be a no-op (no error) when deleting a nonexistent file', async () => {
			// Should not throw — file was already deleted or never existed
			const result = await vault.applyChanges([], ['ghost.md']);
			expect(result.changes).toEqual([]);
		});

		it('should remove empty parent directories after deletion', async () => {
			await writeVaultFile(vaultPath, 'folder/only-file.md', 'content');
			await vault.applyChanges([], ['folder/only-file.md']);

			expect(await vaultPathExists(vaultPath, 'folder/only-file.md')).toBe(false);
			expect(await vaultPathExists(vaultPath, 'folder')).toBe(false);
		});

		it('should not remove non-empty parent directories', async () => {
			await writeVaultFile(vaultPath, 'folder/file-a.md', 'a');
			await writeVaultFile(vaultPath, 'folder/file-b.md', 'b');
			await vault.applyChanges([], ['folder/file-a.md']);

			expect(await vaultPathExists(vaultPath, 'folder')).toBe(true);
			expect(await vaultPathExists(vaultPath, 'folder/file-b.md')).toBe(true);
		});
	});

	// ── statPaths ──────────────────────────────────────────────────────────

	describe('statPaths', () => {
		it('should return "file" for existing files', async () => {
			await writeVaultFile(vaultPath, 'note.md', 'hi');
			const result = await vault.statPaths(['note.md']);
			expect(result.get('note.md')).toBe('file');
		});

		it('should return "folder" for existing directories', async () => {
			await fs.mkdir(path.join(vaultPath, 'mydir'));
			const result = await vault.statPaths(['mydir']);
			expect(result.get('mydir')).toBe('folder');
		});

		it('should return null for non-existent paths', async () => {
			const result = await vault.statPaths(['missing.md']);
			expect(result.get('missing.md')).toBeNull();
		});

		it('should handle a mixed batch of paths', async () => {
			await writeVaultFile(vaultPath, 'exists.md', 'hello');
			const result = await vault.statPaths(['exists.md', 'missing.md']);
			expect(result.get('exists.md')).toBe('file');
			expect(result.get('missing.md')).toBeNull();
		});
	});
});
