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
			await fs.promises.mkdir(path.join(vaultDir, 'notes'), { recursive: true });

			try {
				const { FileSystemAdapter } = await import('obsidian');
				const adapter = new FileSystemAdapter();
				adapter.getBasePath = () => vaultDir;

				// Nested so `../target.md` stays inside the vault (a root-level link with
				// this target would escape it — see the target-validation tests below).
				const wrote = await writeSymlink(adapter, 'notes/link.md', '../target.md');

				expect({
					wrote,
					isSymlink: (await fs.promises.lstat(path.join(vaultDir, 'notes', 'link.md'))).isSymbolicLink(),
					target: await fs.promises.readlink(path.join(vaultDir, 'notes', 'link.md')),
				}).toEqual({ wrote: true, isSymlink: true, target: '../target.md' });
			} finally {
				await fs.promises.rm(tmpRoot, { recursive: true, force: true });
			}
		});

		// Target comes from a remote git tree entry — untrusted. See symlinkTargetStaysInVault.
		it.each([
			['absolute target', 'notes/link.md', '/home/user/.ssh'],
			['windows drive target', 'notes/link.md', 'C:/Users/user/.ssh'],
			['backslash target', 'notes/link.md', '..\\outside'],
			['empty target', 'notes/link.md', ''],
			['".." climbs past vault root from a nested link', 'notes/link.md', '../../outside'],
			['".." climbs past vault root from a root-level link', 'link.md', '../outside'],
			['".." after a normal segment', 'notes/link.md', 'sub/../../../outside'],
		])('refuses a symlink target that could resolve outside the vault: %s', async (_label, linkPath, target) => {
			const fs = await import('fs');
			const os = await import('os');
			const path = await import('path');

			const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fit-writesymlink-target-test-'));
			const vaultDir = path.join(tmpRoot, 'vault');
			await fs.promises.mkdir(path.join(vaultDir, 'notes'), { recursive: true });

			try {
				const { FileSystemAdapter } = await import('obsidian');
				const adapter = new FileSystemAdapter();
				adapter.getBasePath = () => vaultDir;

				const wrote = await writeSymlink(adapter, linkPath, target);

				expect({
					wrote,
					linkCreated: await fs.promises.lstat(path.join(vaultDir, linkPath)).then(() => true, () => false),
				}).toEqual({ wrote: false, linkCreated: false });
			} finally {
				await fs.promises.rm(tmpRoot, { recursive: true, force: true });
			}
		});

		// Two links that each look fine in isolation but climb out together: `p/q` -> `..` is
		// legal (resolves to the vault root), after which `p/q/s`'s lexical parent `p/q` looks
		// two levels deep while its real parent is the vault root itself. A purely lexical
		// check would allow `p/q/s` -> `../..` (resolves to the vault's parent).
		it('refuses a target that only escapes via an earlier in-vault symlink in the link\'s own path', async () => {
			const fs = await import('fs');
			const os = await import('os');
			const path = await import('path');

			const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fit-writesymlink-chain-test-'));
			const vaultDir = path.join(tmpRoot, 'vault');
			await fs.promises.mkdir(path.join(vaultDir, 'p'), { recursive: true });

			try {
				const { FileSystemAdapter } = await import('obsidian');
				const adapter = new FileSystemAdapter();
				adapter.getBasePath = () => vaultDir;
				const firstLinkWrote = await writeSymlink(adapter, 'p/q', '..');

				const secondLinkWrote = await writeSymlink(adapter, 'p/q/s', '../..');

				expect({
					firstLinkWrote, // Legal on its own: resolves to the vault root
					secondLinkWrote, // Would resolve to the vault's parent via the first link
					escapedLinkCreated: await fs.promises.lstat(path.join(vaultDir, 's')).then(() => true, () => false),
				}).toEqual({ firstLinkWrote: true, secondLinkWrote: false, escapedLinkCreated: false });
			} finally {
				await fs.promises.rm(tmpRoot, { recursive: true, force: true });
			}
		});
	});
});
