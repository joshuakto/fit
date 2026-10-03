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
 * Whether a symlink at `absolutePath` pointing at `target` resolves inside the vault.
 * `target` comes from a remote git tree entry, so it is untrusted: a planted link to
 * e.g. `/home/user/.ssh` would otherwise surface files outside the vault to Obsidian's
 * indexer, and FIT would then push them. Rules:
 * - Absolute targets (`/`, `\`, drive letter) are refused outright — an absolute path is
 *   device-specific, so it can't mean the same thing across synced devices anyway.
 * - `..` is only allowed as a leading run (`../../x`), never after a normal segment
 *   (`x/../..`), since `x` could itself be a symlink and make the physical resolution
 *   differ from the lexical one.
 * - The leading `..` count is measured against the link's *real* parent directory
 *   (realpath), not its lexical one: an earlier in-vault symlink in the path (`a/b` ->
 *   `..`) changes how deep the parent really is, which two chained links could otherwise
 *   use to climb out while each looks fine in isolation.
 */
async function symlinkTargetStaysInVault(
	fs: typeof import('fs'),
	nodePath: typeof import('path'),
	basePath: string,
	absolutePath: string,
	target: string
): Promise<boolean> {
	if (target === '' || target.includes('\0') || target.includes('\\')) return false;
	if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return false;

	const segments = target.split('/').filter(s => s !== '' && s !== '.');
	const ups = segments.findIndex(s => s !== '..');
	const leadingUps = ups === -1 ? segments.length : ups;
	if (segments.slice(leadingUps).includes('..')) return false;

	const realBase = await fs.promises.realpath(basePath);
	const realParent = await fs.promises.realpath(nodePath.dirname(absolutePath));
	const rel = nodePath.relative(realBase, realParent);
	if (rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) return false;
	const parentDepth = rel === '' ? 0 : rel.split(nodePath.sep).length;
	return leadingUps <= parentDepth;
}

/**
 * Create (or replace) a real symlink at a vault-relative path pointing at `target`
 * (desktop only). Refuses a `target` that resolves outside the vault (see
 * `symlinkTargetStaysInVault`). Removes any pre-existing *file* entry at that path first — a previous
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
	const nodePath = await import('path').catch(() => null);
	if (!fs || !nodePath) return false;
	try {
		const basePath = adapter.getBasePath();
		const absolutePath = `${basePath}/${path}`;
		if (!(await symlinkTargetStaysInVault(fs, nodePath, basePath, absolutePath, target))) return false;
		const existing = await fs.promises.lstat(absolutePath).catch(() => null);
		if (existing?.isDirectory()) return false;
		await fs.promises.rm(absolutePath, { force: true, recursive: true });
		await fs.promises.symlink(target, absolutePath);
		return true;
	} catch {
		return false;
	}
}
