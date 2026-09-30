/**
 * Local Vault Implementation
 *
 * Implements IVault for Obsidian vault files.
 */

import { DataAdapter, ListedFiles, TFile, TFolder, Vault } from "obsidian";
import { FITATTRIBUTES_PATH } from "@/fitAttributes";
import { ApplyChangesResult, IVault, VaultError, VaultReadResult } from "./vault";
import { FileChange } from "./util/changeTracking";
import { fitLogger } from "./logger";
import { Base64Content, FileContent } from "./util/contentEncoding";
import { contentToArrayBuffer, readFileContent } from "./util/obsidianHelpers";
import { BlobSha, computeGitBlobSha, computeSha1 } from "./util/hashing";
import { FilePath, detectNormalizationIssues } from "./util/filePath";
import { withSlowOperationMonitoring } from "./util/asyncMonitoring";
import { findSuspiciousCorrespondences } from "./util/pathPattern";
import { GitignoreFilter } from "./util/gitignore";
import { isSymlink, readSymlinkTarget, supportsSymlinks, writeSymlink } from "./util/desktopCompat";

/**
 * Helper to process Promise.allSettled results and collect failures
 */
function collectSettledFailures<T>(
	results: PromiseSettledResult<T>[],
	paths: string[]
): Array<{path: string; error: unknown}> {
	const failures: Array<{path: string; error: unknown}> = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (result.status === 'rejected') {
			failures.push({ path: paths[i], error: result.reason });
		}
	}
	return failures;
}

/**
 * Extensions that used base64 (not plaintext) in the legacy v1 SHA algorithm.
 * Preserved for fileLegacySha1 so the v1→v2 migration can reproduce old SHAs exactly.
 */
const LEGACY_BINARY_EXT_FOR_SHA = new Set(["png", "jpg", "jpeg", "pdf"]);

function isBinaryExtensionForLegacySha(extension: string): boolean {
	const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
	return LEGACY_BINARY_EXT_FOR_SHA.has(normalized.toLowerCase());
}

/**
 * Path components that are tooling metadata rather than vault content. Walking into them
 * costs a full recursive scan and surfaces files nobody means to sync: a plugin directory
 * carrying its own git history turns one sync into thousands of paths. Matched as a whole
 * component so `.gitignore` and `.gitattributes` stay syncable.
 */
const PRUNED_PATH_COMPONENTS = new Set(['.git', '.jj', '.hg', '.svn', '.bzr']);

function containsPrunedComponent(path: string): boolean {
	return path.split('/').some(part => PRUNED_PATH_COMPONENTS.has(part));
}

// Symlink detection (isSymlink, from ./util/desktopCompat) is used two ways here:
// - Inside the hidden-path walk below: skip recursing into a symlinked folder, so a
//   cycle can't blow up the scan. The `visited` set is kept as a second, independent
//   guard even with real detection present — isSymlink fails closed (falls back to "not
//   a symlink") on any resolution/lstat error, and a cycle could in principle come from
//   something other than a symlink (bind mount, FUSE, a network-mapped filesystem) that
//   this walk has no way to identify directly. Cheap (one Set, O(1) per directory) and
//   never wrong to have as a backstop.
// - In readFromSource() further down: detect a symlinked *file* (hidden or not) so its
//   target string, not its resolved content, is what gets hashed/synced — see
//   docs/sync-logic.md § Symlink baseline.
//
// TODO: overlay the hidden-path walk onto `vault.getFiles()`'s existing index instead of
// an independent scan with bolted-on symlink/prune heuristics — a path the index already
// reports could skip this check entirely. Needs confirming what Obsidian's indexer does
// with symlinks first; a real design change, not attempted here.

/**
 * Recursively scan vault adapter for hidden file paths (any path component starts with '.').
 * vault.getFiles() does not return hidden files, so this adapter-based scan is needed
 * when syncHiddenFiles is enabled. Results are vault-relative paths.
 */
interface HiddenPathScanResult {
	paths: string[];
	// Rollup counts only (see #389) - individual pruned-dir/symlink paths are not logged
	// per-entry. A vault with many pruned/skipped dirs would otherwise multiply the same
	// unbounded-array-logging problem this scan's own fix was meant to avoid; a count
	// folded into the existing scan-summary log line is enough to see the mechanism is
	// active without another per-item dump. Revisits caught by the `visited` guard (#390)
	// aren't counted separately — they're cycle-prevention, not a category worth its own
	// tally.
	prunedDirsSkipped: number;
	symlinksSkipped: number;
	// Full path lists behind the two counts above — never logged (see orphanedScanPrefixes
	// below; docs/sync-logic.md § Symlink baseline, "Scan-time pruning vs. the stored baseline").
	skippedFolders: string[];
}

async function scanHiddenPaths(adapter: DataAdapter): Promise<HiddenPathScanResult> {
	const results: string[] = [];
	const skippedPrunedDirs: string[] = [];
	const skippedSymlinks: string[] = [];
	await collectHiddenInDir(adapter, '/', results, false, new Set<string>(), skippedPrunedDirs, skippedSymlinks);
	return {
		paths: results,
		prunedDirsSkipped: skippedPrunedDirs.length,
		symlinksSkipped: skippedSymlinks.length,
		skippedFolders: [...skippedPrunedDirs, ...skippedSymlinks]
	};
}

async function collectHiddenInDir(
	adapter: DataAdapter,
	dir: string,
	results: string[],
	dirIsHidden: boolean,
	visited: Set<string>,
	skippedPrunedDirs: string[],
	skippedSymlinks: string[]
): Promise<void> {
	// Obsidian resolves a symlinked directory while reporting the link's own path, and
	// DataAdapter exposes no lstat/realpath to tell the two apart from a listing alone —
	// see the module-level comment above for why this stays even with real isSymlink
	// detection below.
	if (visited.has(dir)) return;
	visited.add(dir);

	let listing: ListedFiles;
	try {
		listing = await adapter.list(dir);
	} catch {
		return;
	}

	for (const file of listing.files) {
		if (containsPrunedComponent(file)) continue;
		// Skip per-file check when already inside a hidden directory — all paths are hidden
		if (dirIsHidden || file.split('/').some(part => part.startsWith('.'))) {
			results.push(file);
		}
	}

	for (const folder of listing.folders) {
		if (containsPrunedComponent(folder)) {
			skippedPrunedDirs.push(folder);
		}
	}

	await Promise.all(
		listing.folders
			.filter(folder => !containsPrunedComponent(folder))
			.map(async folder => {
				const folderIsHidden = dirIsHidden || folder.split('/').some(p => p.startsWith('.'));
				// Symlink detection only matters (and only costs an lstat) inside a hidden
				// subtree — a symlink reachable purely through non-hidden path components is
				// already covered by Obsidian's own vault.getFiles() index/indexer, which this
				// hidden-only scan doesn't duplicate for non-hidden content anyway.
				if (folderIsHidden && await isSymlink(adapter, folder)) {
					skippedSymlinks.push(folder);
					return;
				}
				await collectHiddenInDir(adapter, folder, results, folderIsHidden, visited, skippedPrunedDirs, skippedSymlinks);
			})
	);
}

/**
 * Local vault implementation for Obsidian.
 *
 * Encapsulates all Obsidian Vault API operations including:
 * - Path filtering (hidden files starting with '.', configurable via syncHiddenFiles setting)
 * - SHA-1 hash computation from vault file contents
 * - Change detection via baseline state comparison
 * - File read/write/delete operations
 *
 * Isolates Obsidian Vault API quirks from sync logic.
 */
export class LocalVault implements IVault<"local"> {
	private vault: Vault;
	private syncHiddenFiles = true;
	// Paths known to be git-tracked (per Fit.trackedObsidianPaths()) — recomputed by the
	// caller every sync from localShas/lastFetchedRemoteShas. Lets readFromSource()
	// proactively probe these specific paths for local discovery even when the broader
	// recursive hidden-path scan is skipped (syncHiddenFiles = false), same pattern
	// already used for .fitattributes.json itself below.
	private trackedHiddenPaths: string[] = [];
	// Symlink target strings found during the last readFromSource() scan, keyed by
	// vault-relative path. Populated desktop-only (see util/desktopCompat.ts). Cached so
	// readFileContent() can return the target string without a second fs.readlink call.
	private symlinkTargets: Map<string, string> = new Map();

	constructor(vault: Vault) {
		this.vault = vault;
	}

	configure(opts: { syncHiddenFiles?: boolean; trackedHiddenPaths?: string[] }): void {
		if (opts.syncHiddenFiles !== undefined) {
			this.syncHiddenFiles = opts.syncHiddenFiles;
		}
		if (opts.trackedHiddenPaths !== undefined) {
			this.trackedHiddenPaths = opts.trackedHiddenPaths;
		}
	}

	/** Whether this runtime can detect/create real symlinks (desktop only). One cheap
	 * capability check — cache the result for the duration of a sync if calling more than
	 * once. */
	async supportsSymlinks(): Promise<boolean> {
		return supportsSymlinks(this.vault.adapter);
	}

	/** Returns file size in bytes, or null if path doesn't exist or is not a file. */
	getFileSizeBytes(path: string): number | null {
		const file = this.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file.stat.size : null;
	}

	/**
	 * Check if path should be included in state tracking.
	 *
	 * Excludes paths that LocalVault cannot reliably read due to Obsidian Vault API limitations:
	 * - Hidden files/directories (starting with .) - Vault API can write them but cannot read them back
	 *
	 * Note: This is specifically for LocalVault storage limitations. Sync policy decisions
	 * (like excluding _fit/ from both local and remote) are handled by Fit.shouldSyncPath().
	 *
	 * Future: When hidden file support is added (using vault.adapter), this can be made
	 * configurable via settings with an opt-out for users who encounter issues.
	 */
	shouldTrackState(filePath: string): boolean {
		// When syncHiddenFiles is disabled, exclude hidden files/directories
		// (any path component starting with .). This is critical because Obsidian's
		// Vault API can write hidden files but cannot read them back
		// (getAbstractFileByPath returns null).
		//
		// When syncHiddenFiles is enabled, hidden files are included and read via
		// vault.adapter.readBinary() instead of the vault index.
		//
		// Obsidian vault paths always use forward slashes (even on Windows)
		if (!this.syncHiddenFiles) {
			// .fitattributes.json must propagate regardless of syncHiddenFiles, or it can't
			// reach a device that has hidden-file sync off — defeating its own purpose.
			if (filePath === FITATTRIBUTES_PATH) return true;

			const parts = filePath.split('/');
			if (parts.some(part => part.startsWith('.'))) {
				// Git-tracked obsidian paths are tracked regardless of syncHiddenFiles
				return this.trackedHiddenPaths.includes(filePath);
			}
		}

		return true;
	}

	/**
	 * Batch stat operation for multiple paths.
	 * Returns the type of each path in parallel for performance.
	 *
	 * @param paths - Paths to check
	 * @returns Map of path to type ('file' | 'folder'), or null if path doesn't exist
	 */
	async statPaths(paths: string[]): Promise<Map<string, 'file' | 'folder' | null>> {
		const stats = await Promise.all(
			paths.map(async (path) => {
				const stat = await this.vault.adapter.stat(path);
				const type = stat ? stat.type : null;
				return [path, type] as const;
			})
		);
		return new Map(stats);
	}

	/**
	 * Scan vault, update latest known state, and return it
	 */
	async readFromSource(): Promise<VaultReadResult<"local">> {
		const allFiles = this.vault.getFiles();
		const vaultIndexPaths = allFiles.map(f => f.path);

		// When syncHiddenFiles is enabled, also discover hidden paths via adapter
		// (vault.getFiles() only returns non-hidden files due to Obsidian API limitations).
		// This involves a full recursive directory scan and has performance overhead.
		let hiddenPaths: string[] = [];
		// Folders this scan skipped — see docs/sync-logic.md § Symlink baseline,
		// "Scan-time pruning vs. the stored baseline".
		let orphanedScanPrefixes: string[] = [];
		if (this.syncHiddenFiles) {
			const scanResult = await scanHiddenPaths(this.vault.adapter);
			hiddenPaths = scanResult.paths;
			orphanedScanPrefixes = scanResult.skippedFolders;
			if (hiddenPaths.length > 0 || scanResult.prunedDirsSkipped > 0 || scanResult.symlinksSkipped > 0) {
				fitLogger.log('[LocalVault] Hidden paths discovered via adapter scan', {
					count: hiddenPaths.length, paths: hiddenPaths,
					prunedDirsSkipped: scanResult.prunedDirsSkipped, symlinksSkipped: scanResult.symlinksSkipped
				});
			}
		}

		// .fitattributes.json is hidden (leading dot) so vault.getFiles() never returns
		// it — must be discovered explicitly when the hidden-path scan above is skipped,
		// or shouldTrackState's special-case for it (below) never gets a chance to run.
		// Only add it if it actually exists locally: injecting a path that doesn't exist
		// would make the SHA-computation step below fail it and abort the whole sync.
		let allPaths = this.syncHiddenFiles ? [...vaultIndexPaths, ...hiddenPaths] : vaultIndexPaths;
		if (!this.syncHiddenFiles && !allPaths.includes(FITATTRIBUTES_PATH)) {
			if (await this.vault.adapter.stat(FITATTRIBUTES_PATH)) {
				allPaths = [...allPaths, FITATTRIBUTES_PATH];
			}
		}

		// Same reasoning as the .fitattributes.json probe above, generalized: a git-tracked
		// .obsidian/ path won't be found by vault.getFiles() (hidden) or by the recursive
		// scan (skipped when syncHiddenFiles = false) unless probed explicitly. Without this,
		// local edits to a tracked path go undetected — and therefore unpushed — whenever
		// syncHiddenFiles is off.
		//
		// Note: this list (Fit.trackedObsidianPaths()) can lag by one sync for a path just
		// reconciled untracked→tracked — that's expected, not a correctness gap. A remote
		// change for a path missing here still gets caught by FitSync's independent
		// filesystem safety check (#169) rather than silently overwriting local content; see
		// Fit.trackedObsidianPaths()'s own comment and docs/sync-logic.md § Baseline
		// Recording for Untracked Files (#169).
		if (!this.syncHiddenFiles) {
			for (const path of this.trackedHiddenPaths) {
				if (allPaths.includes(path)) continue;
				if (await this.vault.adapter.stat(path)) {
					allPaths = [...allPaths, path];
				}
			}
		}

		// Filter to only tracked paths (excludes hidden files when syncHiddenFiles is off)
		const trackedPaths = allPaths.filter(path => this.shouldTrackState(path));
		const untrackedPaths = allPaths.filter(path => !this.shouldTrackState(path));

		// Create map for quick file size lookups (vault-indexed files only; hidden files lack TFile.stat)
		const fileSizeMap = new Map(allFiles.map(f => [f.path, f.stat.size]));

		if (untrackedPaths.length > 0) {
			fitLogger.log('[LocalVault] Untracked paths in local scan (hidden files)', {
				paths: untrackedPaths
			});
		}

		// Load .gitignore filters; pass allPaths so already-scanned .gitignore
		// entries skip a redundant stat.
		const allPathsSet = new Set(allPaths);
		const gitignoreFilter = await GitignoreFilter.load(this.vault.adapter, trackedPaths, allPathsSet);

		// Filter out paths matched by .gitignore patterns
		let pathsToScan: string[];
		if (!gitignoreFilter.isEmpty) {
			const { kept, ignored } = gitignoreFilter.filter(trackedPaths);
			pathsToScan = kept;
			if (ignored.length > 0) {
				fitLogger.log('[LocalVault] Paths ignored by .gitignore', { paths: ignored });
			}
		} else {
			pathsToScan = trackedPaths;
		}

		// Symlink detection (desktop only — see util/desktopCompat.ts): a symlinked path's
		// "content" for hashing/sync purposes is its target string, not the resolved
		// target's bytes — see docs/sync-logic.md § Symlink baseline. Checked for every
		// path, not just hidden ones: an ordinary non-hidden symlink is a symlink too.
		const symlinkCapable = await supportsSymlinks(this.vault.adapter);
		const newSymlinkTargets = new Map<string, string>();
		const symlinkPaths = new Set<string>();

		// Compute SHAs for all non-ignored files
		// Monitor for slow operations that could cause mobile crashes
		// Use allSettled to collect both successes and failures per file
		const shaResults = await withSlowOperationMonitoring(
			Promise.allSettled(
				pathsToScan.map(async (path): Promise<[string, BlobSha]> => {
					if (symlinkCapable && await isSymlink(this.vault.adapter, path)) {
						const target = await readSymlinkTarget(this.vault.adapter, path);
						if (target !== null) {
							newSymlinkTargets.set(path, target);
							symlinkPaths.add(path);
							const sha = await LocalVault.fileSha1(path, FileContent.fromPlainText(target));
							return [path, sha];
						}
						// readSymlinkTarget failed after isSymlink said yes (rare race/perm
						// issue) — fall through to reading it as a regular file below.
					}
					const sha = await LocalVault.fileSha1(
						path, await readFileContent(this.vault, path));
					return [path, sha];
				})
			),
			`Local vault SHA computation (${pathsToScan.length} files)`,
			{ warnAfterMs: 10000 }
		);
		this.symlinkTargets = newSymlinkTargets;

		// Separate successes from failures
		const shaEntries: Array<[string, BlobSha]> = [];
		const failedPaths: Array<{path: string, error: unknown}> = [];

		shaResults.forEach((result, index) => {
			const path = pathsToScan[index];
			if (result.status === 'fulfilled') {
				shaEntries.push(result.value);
			} else {
				let error = result.reason;
				const fileSize = fileSizeMap.get(path);

				// For large files, augment error with size context
				// Use conservative 10MB threshold (failures seen with 30MB, varies by device)
				const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB
				if (fileSize && fileSize >= LARGE_FILE_THRESHOLD) {
					const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
					const origMsg = error instanceof Error ? error.message : String(error);
					error = new Error(`${origMsg} (file size: ${sizeMB}MB - may exceed sync limits)`);
				}

				failedPaths.push({ path, error });
				fitLogger.log(`❌ [LocalVault] Failed to process file: ${path}`, error);
			}
		});

		// If any files failed, throw a VaultError with details.
		// TODO: Instead of aborting on partial failure, skip unreadable files and include
		// partialState (Object.fromEntries(shaEntries)) in details so callers can process
		// the files that succeeded. This would unblock sync for vaults with permission-restricted
		// files (e.g. EACCES) — see related issue for sync-level graceful degradation.
		if (failedPaths.length > 0) {
			throw new VaultError(
				'filesystem',
				`Failed to read ${failedPaths.length} file(s) from local vault: ${failedPaths.map(f => f.path).join(', ')}`,
				{
					failedPaths: failedPaths.map(f => f.path),
					errors: failedPaths.map(f => ({ path: f.path, error: f.error }))
				}
			);
		}

		const newState = Object.fromEntries(shaEntries);

		// Log computed SHAs for provenance tracking, with normalization diagnostics
		const normalizationInfo = detectNormalizationIssues(trackedPaths, 'local filesystem');
		fitLogger.log(
			`... 💾 [LocalVault] Scanned ${Object.keys(newState).length} files`,
			normalizationInfo ? { nfdPaths: normalizationInfo.nfdCount } : undefined
		);

		return { state: { ...newState }, symlinkPaths, orphanedScanPrefixes: new Set(orphanedScanPrefixes) };
	}

	/**
	 * Compute the canonical Git blob SHA-1 for a file.
	 *
	 * Uses the same algorithm as GitHub (SHA1("blob " + byteLen + NUL + rawBytes)),
	 * so local and remote SHAs are directly comparable when encryption is off.
	 * The path is not included in the hash; it is accepted only for call-site
	 * compatibility (tests and scan loop both pass it).
	 */
	// NOTE: Public visibility for tests.
	static fileSha1(_path: string, fileContent: FileContent): Promise<BlobSha> {
		return computeGitBlobSha(fileContent.toBytes());
	}

	/**
	 * Compute the legacy v1 SHA (SHA1(normalizedPath + content)) for a file.
	 * Used only during v1→v2 schema migration to check whether a file's content
	 * has changed since it was last hashed with the old algorithm.
	 */
	// NOTE: Public visibility for migration use in fit.ts.
	static fileLegacySha1(path: string, fileContent: FileContent): Promise<BlobSha> {
		const normalizedPath = FilePath.create(path);
		const extension = FilePath.getExtension(normalizedPath);
		let contentToHash: string;
		if (extension && isBinaryExtensionForLegacySha(extension)) {
			contentToHash = fileContent.toBase64();
		} else {
			try {
				contentToHash = fileContent.toPlainText();
			} catch {
				contentToHash = fileContent.toBase64();
			}
		}
		return computeSha1(normalizedPath + contentToHash) as Promise<BlobSha>;
	}

	/**
	 * Ensure folder exists for a given file path (creates parent directories recursively)
	 *
	 * Uses a functional approach to decide between Vault API and adapter:
	 * - If getAbstractFileByPath returns a folder, it exists and Vault API can see it
	 * - If getAbstractFileByPath returns null, check adapter.stat to see if it exists on disk
	 * - For creation: use Vault API if the path is trackable, adapter otherwise
	 */
	private async ensureFolderExists(path: string): Promise<void> {
		// Extract folder path, return empty string if no folder path is matched (exclude the last /)
		const folderPath = path.match(/^(.*)\//)?.[1] || '';
		if (folderPath === '') {
			// At root, no parent to create
			return;
		}

		// Split path into parts and create each level if needed
		const parts = folderPath.split('/');
		let currentPath = '';

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			// First, check if Vault API can see this folder
			const abstractFile = this.vault.getAbstractFileByPath(currentPath);
			if (abstractFile) {
				// Vault API can see it - check if it's a folder or file
				if (abstractFile instanceof TFile) {
					throw new Error(`Cannot create folder at ${currentPath}: a file already exists at this path`);
				}
				// It's a folder (TFolder or similar), continue to next level
				continue;
			}

			// Vault API returns null - either folder doesn't exist, or it's a hidden path
			// Check adapter.stat to see if it exists on disk
			let stat;
			try {
				stat = await this.vault.adapter.stat(currentPath);
			} catch {
				// Adapter throws for non-existent paths, treat as not existing
				stat = null;
			}

			if (stat) {
				if (stat.type === 'file') {
					throw new Error(`Cannot create folder at ${currentPath}: a file already exists at this path`);
				}
				// Folder exists on disk (hidden folder), continue to next level
				continue;
			}

			// Folder doesn't exist, create it.
			// Vault API (createFolder) can't manage hidden paths even when syncHiddenFiles is on —
			// the limitation is in the Vault API itself, not in our tracking preference.
			const folderIsHidden = currentPath.split('/').some(p => p.startsWith('.'));
			try {
				if (!folderIsHidden) {
					// Non-hidden path - use vault API (keeps vault index in sync)
					await this.vault.createFolder(currentPath);
				} else {
					// Hidden path - Vault API can't manage it, use adapter directly
					await this.vault.adapter.mkdir(currentPath);
				}
			} catch (error) {
				// Race condition safeguard: if folder was created concurrently, ignore error
				let recheckStat;
				try {
					recheckStat = await this.vault.adapter.stat(currentPath);
				} catch {
					// Can't verify folder exists, re-throw original error
					throw error;
				}
				if (!recheckStat || recheckStat.type !== 'folder') {
					throw error;
				}
			}
		}
	}

	/**
	 * Read file content for a specific path
	 */
	async readFileContent(path: string): Promise<FileContent> {
		const target = this.symlinkTargets.get(path);
		if (target !== undefined) {
			return FileContent.fromPlainText(target);
		}
		return readFileContent(this.vault, path);
	}

	/**
	 * Write or update a file and optionally compute its SHA.
	 * Uses the appropriate Obsidian API based on file encoding:
	 * - Plaintext files: vault.create() / vault.modify()
	 * - Binary files: vault.createBinary() / vault.modifyBinary()
	 *
	 * @param path - File path (where to write the file)
	 * @param content - File content (always Base64Content - GitHub API returns all blobs as base64)
	 * @param originalContent - The FileContent object we're writing (for SHA computation and encoding detection)
	 * @param shaPath - Optional path to use for SHA computation (if different from write path, for clash files)
	 * @returns Record of file operation performed and SHA promise (always computed for baseline tracking)
	 */
	private async writeFile(
		path: string,
		content: Base64Content,
		originalContent: FileContent,
		shaPath?: string
	): Promise<{ change: FileChange; shaPromise: Promise<BlobSha> | null }> {
		try {
			const file = this.vault.getAbstractFileByPath(path);
			const rawContent = originalContent.toRaw();
			const isPlaintext = rawContent.encoding === 'plaintext';

			let changeType: 'ADDED' | 'MODIFIED';

			if (file && file instanceof TFile) {
				// File is in vault index - use standard modify
				if (isPlaintext) {
					await this.vault.modify(file, rawContent.content);
				} else {
					await this.vault.modifyBinary(file, contentToArrayBuffer(content));
				}
				changeType = 'MODIFIED';
			} else if (file instanceof TFolder) {
				// Path exists as a folder
				throw new Error(`Cannot write file to ${path}: a folder with that name already exists`);
			} else if (file) {
				// Unknown type - future-proof for new Obsidian abstract file types
				throw new Error(`Cannot write file to ${path}: path exists but is not a file (type: ${file.constructor.name})`);
			} else {
				// File not in vault index - check if it exists on disk (hidden files)
				// See docs/api-compatibility.md "Reading Untracked Files"
				let existsOnDisk = false;
				try {
					// stat() can throw or return null for non-existent files depending on adapter implementation.
					// A successful stat returns a Stat object, which is truthy.
					existsOnDisk = !!(await this.vault.adapter.stat(path));
				} catch {
					// If it throws, the file doesn't exist.
					existsOnDisk = false;
				}

				if (existsOnDisk) {
					// File exists but not in index - use adapter to modify
					if (isPlaintext) {
						await this.vault.adapter.write(path, rawContent.content);
					} else {
						await this.vault.adapter.writeBinary(path, contentToArrayBuffer(content));
					}
					changeType = 'MODIFIED';
				} else {
					// File doesn't exist - create new
					await this.ensureFolderExists(path);
					if (isPlaintext) {
						await this.vault.create(path, rawContent.content);
					} else {
						await this.vault.createBinary(path, contentToArrayBuffer(content));
					}
					changeType = 'ADDED';
				}
			}

			// Compute SHA once at the end for all paths
			return {
				change: { path, type: changeType },
				shaPromise: this.computeShaIfNeeded(shaPath, path, originalContent)
			};
		} catch (error) {
			// Re-throw VaultError as-is (don't double-wrap)
			if (error instanceof VaultError) {
				throw error;
			}
			const message = error instanceof Error ? error.message : `Failed to write file: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}
	}

	/**
	 * Write a real symlink at `path` pointing at `content`'s target-path text (desktop
	 * only — see util/desktopCompat.ts). Caller (applyChanges) is responsible for only
	 * setting `isSymlink` when the source vault actually flagged the path as a symlink;
	 * this method still checks `supportsSymlinks()` defensively and falls back to an
	 * ordinary content write (never silently drops the sync) if unsupported, logging why.
	 */
	private async writeFileAsSymlink(
		path: string,
		content: FileContent,
		shaPath?: string
	): Promise<{ change: FileChange; shaPromise: Promise<BlobSha> | null }> {
		if (!(await supportsSymlinks(this.vault.adapter))) {
			fitLogger.log(
				`[LocalVault] Symlink write requested but unsupported on this platform, ` +
				`writing regular content instead: ${path}`
			);
			return this.writeFile(path, content.toBase64(), content, shaPath);
		}

		const target = content.toPlainText();
		const changeType: 'ADDED' | 'MODIFIED' = this.vault.getAbstractFileByPath(path) ? 'MODIFIED' : 'ADDED';
		await this.ensureFolderExists(path);
		const wrote = await writeSymlink(this.vault.adapter, path, target);
		if (!wrote) {
			throw VaultError.filesystem(`Failed to write symlink: ${path}`);
		}

		return {
			change: { path, type: changeType },
			shaPromise: this.computeShaIfNeeded(shaPath, path, content)
		};
	}

	/**
	 * Compute SHA for a file if needed based on tracking rules.
	 * See docs/sync-logic.md "SHA Computation from In-Memory Content" for rationale.
	 */
	private computeShaIfNeeded(
		shaPath: string | undefined,
		writePath: string,
		content: FileContent
	): Promise<BlobSha> | null {
		// Compute SHA if:
		// 1. Direct write (shaPath === undefined), OR
		// 2. Untracked clash file (shaPath defined AND !shouldTrackState)
		// Tracked clash files self-heal via local scan, so skip SHA computation (#169)
		const pathForSha = shaPath ?? writePath;
		if (shaPath === undefined || !this.shouldTrackState(pathForSha)) {
			return LocalVault.fileSha1(pathForSha, content);
		}
		return null;
	}

	/**
	 * Delete a file
	 * @returns Record of file operation performed
	 */
	private async deleteFile(path: string): Promise<FileChange> {
		try {
			const file = this.vault.getAbstractFileByPath(path);
			if (file && file instanceof TFile) {
				// File is in vault index - use standard deletion
				await this.vault.delete(file);
				return {path, type: "REMOVED"};
			} else if (file instanceof TFolder) {
				throw new Error(`Cannot delete ${path}: it is a folder, not a file`);
			} else if (file) {
				throw new Error(`Cannot delete ${path}: unknown file type (${file.constructor.name})`);
			}

			// File not in vault index - use adapter to delete (hidden files)
			// See docs/api-compatibility.md "Reading Untracked Files"
			await this.vault.adapter.remove(path);
			return {path, type: "REMOVED"};
		} catch (error) {
			// Re-throw VaultError as-is (don't double-wrap)
			if (error instanceof VaultError) {
				throw error;
			}
			const message = error instanceof Error ? error.message : `Failed to delete file: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}
	}

	/**
	 * Apply a batch of changes (writes and deletes)
	 * Expects all content to be Base64Content (from GitHub API)
	 *
	 * @param options.clashPaths - Set of paths that should be written as clash files to `_fit/{path}`.
	 *   For tracked files: computes SHA for original path (enables baseline tracking).
	 *   For untracked files: SHA computed for original path (enables baseline tracking).
	 *   Returned newBaselineStates uses original path as key, not write path.
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent, isSymlink?: boolean}>,
		filesToDelete: Array<string>,
		options?: { clashPaths?: Set<string> }
	): Promise<ApplyChangesResult<"local">> {
		const clashPaths = options?.clashPaths ?? new Set();
		// Diagnostic: detect remote paths that share an ASCII-alphanumeric-sandwich pattern
		// with an existing local file but differ in non-ASCII content (Issue #51).
		// Note: vault.getFiles() may be unavailable in test mocks
		const allExistingPaths = this.vault.getFiles?.()?.map(f => f.path) ?? [];
		const suspiciousWrites: Array<{remote: string, local: string, pattern: string}> = [];

		for (const {path: remotePath} of filesToWrite) {
			if (!/[^\x00-\x7F]/.test(remotePath)) continue;
			if (this.vault.getAbstractFileByPath(remotePath)) continue;
			for (const match of findSuspiciousCorrespondences(remotePath, allExistingPaths)) {
				suspiciousWrites.push({ remote: match.candidate, local: match.existing, pattern: match.pattern });
			}
		}

		if (suspiciousWrites.length > 0) {
			fitLogger.log(
				`⚠️  [LocalVault] Suspicious filenames detected during sync!\n` +
				`Attempting to create ${suspiciousWrites.length} local file(s), each matching an existing local file:\n` +
				suspiciousWrites.map(({remote, local, pattern}, i) =>
					`  ${i + 1}. Remote: "${remote}" ↔ Local: "${local}"\n` +
					`     Match: "${pattern}" = "${pattern}" ✅`
				).join('\n') +
				`\nThis may indicate encoding corruption from a previous sync.\n` +
				`If the remote filenames look wrong, check GitHub and delete corrupted versions.\n` +
				`See Issue #51: https://github.com/joshuakto/fit/issues/51`,
				{ suspiciousWrites, issue: 'https://github.com/joshuakto/fit/issues/51' }
			);
		}

		const userWarning = suspiciousWrites.length > 0
			? `⚠️ Encoding Issue Detected\n` +
				`Suspicious filename patterns found during sync. ` +
				`Check console logs for details or see Issue #51.`
			: undefined;

		// Process file additions or updates
		// Monitor for slow file write operations
		const writeSettledResults = await withSlowOperationMonitoring(
			Promise.allSettled(
				filesToWrite.map(async ({path, content, isSymlink: writeAsSymlink}) => {
					// If path is in clashPaths, write to _fit/ subdirectory
					const writePath = clashPaths.has(path) ? `_fit/${path}` : path;
					const shaPath = clashPaths.has(path) ? path : undefined;
					if (writeAsSymlink) {
						return this.writeFileAsSymlink(writePath, content, shaPath);
					}
					return this.writeFile(writePath, content.toBase64(), content, shaPath);
				})
			),
			`Local vault file writes (${filesToWrite.length} files)`,
			{ warnAfterMs: 10000 }
		);

		// Process file deletions
		const deletionSettledResults = await withSlowOperationMonitoring(
			Promise.allSettled(
				filesToDelete.map(async (path) => this.deleteFile(path))
			),
			`Local vault file deletions (${filesToDelete.length} files)`,
			{ warnAfterMs: 10000 }
		);

		// Collect successful operations and failures
		const writeResults: Array<{index: number, change: FileChange, shaPromise?: Promise<BlobSha>}> = [];
		const writeFailures = collectSettledFailures(writeSettledResults, filesToWrite.map(f => f.path));

		for (let i = 0; i < writeSettledResults.length; i++) {
			const result = writeSettledResults[i];
			const {path} = filesToWrite[i];

			if (result.status === 'fulfilled') {
				const {change, shaPromise} = result.value;
				writeResults.push({ index: i, change, shaPromise: shaPromise ?? undefined });
			} else {
				const failure = writeFailures.find(f => f.path === path);
				fitLogger.log(`❌ [LocalVault] Failed to write file: ${path}`, failure?.error);
			}
		}

		const deletionOps: FileChange[] = [];
		const deleteFailures = collectSettledFailures(deletionSettledResults, filesToDelete);

		for (let i = 0; i < deletionSettledResults.length; i++) {
			const result = deletionSettledResults[i];
			const path = filesToDelete[i];

			if (result.status === 'fulfilled') {
				deletionOps.push(result.value);
			} else {
				const failure = deleteFailures.find(f => f.path === path);
				fitLogger.log(`❌ [LocalVault] Failed to delete file: ${path}`, failure?.error);
			}
		}

		const failedPaths = [...writeFailures, ...deleteFailures].map(f => f.path);

		// Extract file operations for return value
		const writeOps = writeResults.map(r => r.change);
		const changes = [...writeOps, ...deletionOps];

		// Collect SHA promises from write operations (started asynchronously in writeFile)
		// Map: original path -> SHA promise (keyed by original path, not write path for clash files)
		// Only includes files with SHA computations (direct writes + untracked clashes) (#169)
		// Tracked clash files are excluded (null shaPromise) as they self-heal via local scan
		const shaPromiseMap: Record<string, Promise<BlobSha>> = {};
		// Post-apply symlink-membership counterpart to shaPromiseMap — same key set (paths
		// entering the SHA baseline this call), since a path's mode baseline must advance
		// at the same commit point as its content baseline (docs/sync-logic.md § Symlink
		// baseline). A clash write (excluded above) leaves the main path's own symlink
		// status untouched too, for the same self-heals-via-local-scan reason.
		const newSymlinkPaths = new Set<string>();
		for (const result of writeResults) {
			if (result.shaPromise) {
				// Key by original path from filesToWrite, not the write path (which may be _fit/...)
				const originalPath = filesToWrite[result.index].path;
				shaPromiseMap[originalPath] = result.shaPromise;
				if (filesToWrite[result.index].isSymlink) newSymlinkPaths.add(originalPath);
			}
		}

		// Return SHA computations as promise for caller to await when ready
		// This allows SHA computation (CPU-intensive) to run in parallel with other sync operations
		const newBaselineStates = Promise.all(
			Object.entries(shaPromiseMap).map(async ([path, shaPromise]) => {
				const sha = await shaPromise;
				return [path, sha] as const;
			})
		).then(entries => Object.fromEntries(entries));

		return {
			changes,
			newBaselineStates,
			newSymlinkPaths,
			userWarning,
			...(failedPaths.length > 0 && { failedPaths })
		};
	}
}
