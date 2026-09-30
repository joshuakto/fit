/**
 * Tests for desktopCompat.ts
 *
 * Covers writeSymlink's own safety checks directly, against a real filesystem
 * (matches localVault.test.ts's real-symlink convention for this module). Not
 * duplicating localVault.test.ts's coverage of the LocalVault call sites that use
 * these functions (isSymlink during the hidden-path scan, writeFileAsSymlink's
 * unsupported-platform fallback) — this file is about writeSymlink's own guards.
 */

import { describe, it, expect } from 'vitest';
import { writeSymlink } from './desktopCompat';

describe('desktopCompat', () => {
	describe('writeSymlink', () => {
		it('refuses to overwrite an existing real directory, and leaves its contents untouched', async () => {
			const fs = await import('fs');
			const os = await import('os');
			const path = await import('path');

			const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fit-writesymlink-dir-test-'));
			const vaultDir = path.join(tmpRoot, 'vault');
			await fs.promises.mkdir(vaultDir);
			await fs.promises.mkdir(path.join(vaultDir, 'notes'));
			await fs.promises.writeFile(path.join(vaultDir, 'notes', 'real.md'), 'real content');

			try {
				const { FileSystemAdapter } = await import('obsidian');
				const adapter = new FileSystemAdapter();
				adapter.getBasePath = () => vaultDir;

				const wrote = await writeSymlink(adapter, 'notes', '../elsewhere');

				expect(wrote).toBe(false);
				// A real directory with real content — never rm -rf'd, per LocalVault.writeFile's
				// own refusal to clobber a folder.
				const stat = await fs.promises.lstat(path.join(vaultDir, 'notes'));
				expect(stat.isDirectory()).toBe(true);
				expect(await fs.promises.readFile(path.join(vaultDir, 'notes', 'real.md'), 'utf-8'))
					.toBe('real content');
			} finally {
				await fs.promises.rm(tmpRoot, { recursive: true, force: true });
			}
		});

		it('refuses a path with a ".." component, without touching the filesystem', async () => {
			const fs = await import('fs');
			const os = await import('os');
			const path = await import('path');

			const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fit-writesymlink-traversal-test-'));
			const vaultDir = path.join(tmpRoot, 'vault');
			await fs.promises.mkdir(vaultDir);

			try {
				const { FileSystemAdapter } = await import('obsidian');
				const adapter = new FileSystemAdapter();
				adapter.getBasePath = () => vaultDir;

				const wrote = await writeSymlink(adapter, '../escaped', 'target');

				expect(wrote).toBe(false);
				// Nothing created outside the vault dir — the traversal path itself must exist.
				await expect(fs.promises.lstat(path.join(tmpRoot, 'escaped'))).rejects.toThrow();
			} finally {
				await fs.promises.rm(tmpRoot, { recursive: true, force: true });
			}
		});

		it('refuses an absolute path, without touching the filesystem', async () => {
			const fs = await import('fs');
			const os = await import('os');
			const path = await import('path');

			const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fit-writesymlink-absolute-test-'));
			const vaultDir = path.join(tmpRoot, 'vault');
			await fs.promises.mkdir(vaultDir);

			try {
				const { FileSystemAdapter } = await import('obsidian');
				const adapter = new FileSystemAdapter();
				adapter.getBasePath = () => vaultDir;

				const wrote = await writeSymlink(adapter, '/etc/evil', 'target');

				expect(wrote).toBe(false);
			} finally {
				await fs.promises.rm(tmpRoot, { recursive: true, force: true });
			}
		});

		it('still writes a real symlink for an ordinary path (regression check for the guards above)', async () => {
			const fs = await import('fs');
			const os = await import('os');
			const path = await import('path');

			const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fit-writesymlink-ok-test-'));
			const vaultDir = path.join(tmpRoot, 'vault');
			await fs.promises.mkdir(vaultDir);

			try {
				const { FileSystemAdapter } = await import('obsidian');
				const adapter = new FileSystemAdapter();
				adapter.getBasePath = () => vaultDir;

				const wrote = await writeSymlink(adapter, 'link.md', '../target.md');

				expect(wrote).toBe(true);
				const stat = await fs.promises.lstat(path.join(vaultDir, 'link.md'));
				expect(stat.isSymbolicLink()).toBe(true);
				expect(await fs.promises.readlink(path.join(vaultDir, 'link.md'))).toBe('../target.md');
			} finally {
				await fs.promises.rm(tmpRoot, { recursive: true, force: true });
			}
		});
	});
});
