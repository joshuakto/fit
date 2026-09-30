/**
 * Desktop-only Node access, behind guards mobile can never trip.
 *
 * Obsidian mobile has no Node.js runtime (see CLAUDE.md's Node-builtins ban and
 * docs/api-compatibility.md's "Narrow exception" note). `DataAdapter` exposes no
 * symlink/inode info, so real symlink detection/read/write needs Node's `fs` — but only
 * reachable through all three guards together: dynamic `import()` (never touched at
 * module load, so never touched on mobile), an `instanceof FileSystemAdapter` gate, and a
 * try/catch fallback to "unsupported" on any resolution or call failure.
 *
 * Used for both hidden-folder symlink-cycle detection (LocalVault's hidden-path scan)
 * and file-level symlink read/write (real symlink content fidelity across sync).
 */

import { DataAdapter, FileSystemAdapter } from "obsidian";

let nodeFsPromise: Promise<typeof import('fs') | null> | null = null;
function getNodeFs(): Promise<typeof import('fs') | null> {
	if (!nodeFsPromise) {
		nodeFsPromise = import('fs').catch(() => null);
	}
	return nodeFsPromise;
}

/** Whether this runtime can detect and create real symlinks (desktop only). */
export async function supportsSymlinks(adapter: DataAdapter): Promise<boolean> {
	if (!(adapter instanceof FileSystemAdapter)) return false;
	return (await getNodeFs()) !== null;
}

/**
 * Best-effort symlink check for a vault-relative path (file or folder). Desktop only;
 * mobile, or any resolution/lstat failure, falls back to `false`.
 */
export async function isSymlink(adapter: DataAdapter, path: string): Promise<boolean> {
	if (!(adapter instanceof FileSystemAdapter)) return false;
	const fs = await getNodeFs();
	if (!fs) return false;
	try {
		const absolutePath = `${adapter.getBasePath()}/${path}`;
		const stat = await fs.promises.lstat(absolutePath);
		return stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Read a symlink's target string (desktop only). Returns null on any failure, including
 * on mobile — callers must not distinguish "not a symlink" from "couldn't check."
 */
export async function readSymlinkTarget(adapter: DataAdapter, path: string): Promise<string | null> {
	if (!(adapter instanceof FileSystemAdapter)) return null;
	const fs = await getNodeFs();
	if (!fs) return null;
	try {
		const absolutePath = `${adapter.getBasePath()}/${path}`;
		return await fs.promises.readlink(absolutePath);
	} catch {
		return null;
	}
}

/**
 * Create (or replace) a real symlink at a vault-relative path pointing at `target`
 * (desktop only). Removes any pre-existing *file* entry at that path first — a previous
 * sync may have left a regular file there — but refuses (returns false) if a real
 * directory already occupies the path, matching LocalVault.writeFile's own refusal to
 * clobber a folder. Also refuses any path with a `..` component or a leading `/`: `path`
 * can originate from a remote git tree entry, and every other write in this codebase
 * goes through Obsidian's Vault API, which sandboxes to the vault root — this raw `fs`
 * call has no such sandbox otherwise. Caller is responsible for ensuring the parent
 * directory exists first (vault-API-aware, so left to LocalVault). Returns false (never
 * throws) on any failure, including on mobile.
 */
export async function writeSymlink(adapter: DataAdapter, path: string, target: string): Promise<boolean> {
	if (!(adapter instanceof FileSystemAdapter)) return false;
	if (path.startsWith('/') || path.split('/').some(part => part === '..')) return false;
	const fs = await getNodeFs();
	if (!fs) return false;
	try {
		const absolutePath = `${adapter.getBasePath()}/${path}`;
		const existing = await fs.promises.lstat(absolutePath).catch(() => null);
		if (existing?.isDirectory()) return false;
		await fs.promises.rm(absolutePath, { force: true, recursive: true });
		await fs.promises.symlink(target, absolutePath);
		return true;
	} catch {
		return false;
	}
}
