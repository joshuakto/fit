/**
 * Local Vault Implementation
 *
 * Implements IVault for Obsidian vault files.
 */

import { TFile, TFolder, Vault } from "obsidian";
import { ApplyChangesResult, IVault, VaultError, VaultReadResult } from "./vault";
import { FileChange } from "./util/changeTracking";
import { fitLogger } from "./logger";
import { Base64Content, FileContent } from "./util/contentEncoding";
import { contentToArrayBuffer, readFileContent } from "./util/obsidianHelpers";
import { BlobSha, computeSha1 } from "./util/hashing";
import { FilePath, detectNormalizationIssues } from "./util/filePath";
import { withSlowOperationMonitoring } from "./util/asyncMonitoring";
import { findSuspiciousCorrespondences } from "./util/pathPattern";

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
 * Frozen list of binary file extensions for SHA calculation consistency.
 *
 * IMPORTANT: This list is FROZEN to prevent spurious sync operations.
 *
 * Why this matters:
 * - Before PR #XXX: Non-listed binaries (.zip, .exe, etc.) had SHAs computed on
 *   CORRUPTED plaintext (with replacement characters �) because toPlainText()
 *   silently corrupted binary data
 * - After PR #XXX: toPlainText() throws on binary, fileSha1() catches and uses base64
 * - Problem: Existing .zip files will get DIFFERENT SHAs (corrupted vs correct)
 * - Result: Plugin detects "change" and tries to sync the same file again
 *
 * Solution:
 * - Keep list FROZEN to avoid batch SHA changes for existing users
 * - New fatal:true logic handles unlisted extensions gracefully via try/catch
 * - Users with .zip files will see ONE spurious sync after upgrading (acceptable)
 *
 * Future: Implement SHA migration strategy to expand this list safely
 * (e.g., version stores, detect and re-hash on upgrade, warn users)
 *
 * DO NOT modify this list unless you implement a SHA migration strategy.
 */
const FROZEN_BINARY_EXT_FOR_SHA = new Set(["png", "jpg", "jpeg", "pdf"]);

/**
 * Check if a file extension is considered binary for SHA calculation purposes.
 * Uses FROZEN_BINARY_EXT_FOR_SHA to ensure SHA consistency.
 *
 * @param extension - File extension WITHOUT leading dot (e.g., "png", not ".png")
 */
function isBinaryExtensionForSha(extension: string): boolean {
	const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
	return FROZEN_BINARY_EXT_FOR_SHA.has(normalized.toLowerCase());
}

/**
 * Local vault implementation for Obsidian.
 *
 * Encapsulates all Obsidian Vault API operations including:
 * - Path filtering (hidden files starting with '.' - Vault API limitation)
 * - SHA-1 hash computation from vault file contents
 * - Change detection via baseline state comparison
 * - File read/write/delete operations
 *
 * Isolates Obsidian Vault API quirks from sync logic.
 */
export class LocalVault implements IVault<"local"> {
	private vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
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
		// Exclude hidden files/directories (any path component starting with .)
		// This is critical because Obsidian's Vault API can write hidden files
		// but cannot read them back (getAbstractFileByPath returns null)
		//
		// Obsidian vault paths always use forward slashes (even on Windows)
		const parts = filePath.split('/');
		if (parts.some(part => part.startsWith('.'))) {
			return false;
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
	async readFromSource(): Promise<VaultReadResult> {
		const allFiles = this.vault.getFiles();

		// Filter to only tracked paths
		const allPaths = allFiles.map(f => f.path);
		const trackedPaths = allPaths.filter(path => this.shouldTrackState(path));
		const ignoredPaths = allPaths.filter(path => !this.shouldTrackState(path));

		// Create map for quick file size lookups
		const fileSizeMap = new Map(allFiles.map(f => [f.path, f.stat.size]));

		if (ignoredPaths.length > 0) {
			fitLogger.log('[LocalVault] Ignored paths in local scan', {
				count: ignoredPaths.length,
				paths: ignoredPaths
			});
		}

		// Compute SHAs for all tracked files
		// Monitor for slow operations that could cause mobile crashes
		// Use allSettled to collect both successes and failures per file
		const shaResults = await withSlowOperationMonitoring(
			Promise.allSettled(
				trackedPaths.map(async (path): Promise<[string, BlobSha]> => {
					const sha = await LocalVault.fileSha1(
						path, await readFileContent(this.vault, path));
					return [path, sha];
				})
			),
			`Local vault SHA computation (${trackedPaths.length} files)`,
			{ warnAfterMs: 10000 }
		);

		// Separate successes from failures
		const shaEntries: Array<[string, BlobSha]> = [];
		const failedPaths: Array<{path: string, error: unknown}> = [];

		shaResults.forEach((result, index) => {
			const path = trackedPaths[index];
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

		// If any files failed, throw a VaultError with details
		if (failedPaths.length > 0) {
			throw new VaultError(
				'filesystem',
				`Failed to read ${failedPaths.length} file(s) from local vault: ${failedPaths.map(f => f.path).join(', ')}`,
				{
					originalError: failedPaths[0].error,
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

		return { state: { ...newState } };
	}

	/**
	 * Compute SHA-1 hash of file path + content
	 * (Matches GitHub's blob SHA format)
	 *
	 * Path is normalized to NFC before hashing to prevent
	 * duplication issues with Unicode normalization (issue #51)
	 */
	// NOTE: Public visibility for tests.
	static fileSha1(path: string, fileContent: FileContent): Promise<BlobSha> {
		// Normalize path to NFC form for consistent hashing across platforms
		const normalizedPath = FilePath.create(path);
		const extension = FilePath.getExtension(normalizedPath);

		let contentToHash: string;
		if (extension && isBinaryExtensionForSha(extension)) {
			// Use base64 representation for consistent hashing
			contentToHash = fileContent.toBase64();
		} else {
			// Preserve plaintext SHA logic for non-binary case.
			// NOTE: For non-FROZEN extensions like .zip, if content is binary,
			// toPlainText() will now throw (due to fatal:true in decodeFromBase64).
			// We intentionally fall back to base64 to avoid corruption.
			// This may cause SHA changes for existing .zip files, but prevents
			// silent replacement character corruption in SHA computation.
			// TODO(future): Implement SHA migration strategy to expand FROZEN_BINARY_EXT_FOR_SHA
			// to include all common binary extensions (.zip, .exe, .bin, etc.)
			try {
				contentToHash = fileContent.toPlainText();
			} catch {
				// Binary content detected (invalid UTF-8) - fall back to base64
				contentToHash = fileContent.toBase64();
			}
		}
		return computeSha1(normalizedPath + contentToHash) as Promise<BlobSha>;
	}

	/**
	 * Ensure folder exists for a given file path
	 */
	private async ensureFolderExists(path: string): Promise<void> {
		// Extract folder path, return empty string if no folder path is matched (exclude the last /)
		const folderPath = path.match(/^(.*)\//)?.[1] || '';
		if (folderPath === '') {
			// At root, no parent to create
			return;
		}

		// Check if path exists and verify it's a folder, not a file
		const existing = this.vault.getAbstractFileByPath(folderPath);
		if (existing) {
			// If it's a file, we can't create a folder at this path
			if (existing instanceof TFile) {
				throw new Error(`Cannot create folder at ${folderPath}: a file already exists at this path`);
			}
			// If it's already a folder, we're done
			if (existing instanceof TFolder) {
				return;
			}
			// Unknown type - shouldn't happen but be defensive
		}

		// Path doesn't exist, create the folder
		try {
			await this.vault.createFolder(folderPath);
		} catch (error) {
			// Race condition safeguard: if folder was created concurrently, ignore error
			const recheckExisting = this.vault.getAbstractFileByPath(folderPath);
			if (!recheckExisting || !(recheckExisting instanceof TFolder)) {
				throw error;
			}
		}
	}

	/**
	 * Read file content for a specific path
	 */
	async readFileContent(path: string): Promise<FileContent> {
		return readFileContent(this.vault, path);
	}

	/**
	 * Write or update a file and optionally compute its SHA.
	 * Uses the appropriate Obsidian API based on file encoding:
	 * - Plaintext files: vault.create() / vault.modify()
	 * - Binary files: vault.createBinary() / vault.modifyBinary()
	 *
	 * @param path - File path
	 * @param content - File content (always Base64Content - GitHub API returns all blobs as base64)
	 * @param originalContent - The FileContent object we're writing (for SHA computation and encoding detection)
	 * @returns Record of file operation performed and SHA promise (if trackable)
	 */
	private async writeFile(
		path: string,
		content: Base64Content,
		originalContent: FileContent,
		shaPath?: string
	): Promise<{ change: FileChange; shaPromise: Promise<BlobSha> | null }> {
		// Use shaPath for SHA computation if provided (for clash files written to _fit/)
		// Why: Local SHA algorithm is path-dependent: SHA1(path + content)
		// When we write .hidden to _fit/.hidden, we must compute SHA for .hidden (not _fit/.hidden)
		// to establish correct baseline. See docs/architecture.md "SHA Algorithms".
		const pathForSha = shaPath ?? path;
		try {
			const file = this.vault.getAbstractFileByPath(path);
			const rawContent = originalContent.toRaw();
			const isPlaintext = rawContent.encoding === 'plaintext';

			if (file && file instanceof TFile) {
				// Modify existing file
				if (isPlaintext) {
					await this.vault.modify(file, rawContent.content);
				} else {
					await this.vault.modifyBinary(file, contentToArrayBuffer(content));
				}
			} else if (!file) {
				// Create new file
				await this.ensureFolderExists(path);
				if (isPlaintext) {
					await this.vault.create(path, rawContent.content);
				} else {
					await this.vault.createBinary(path, contentToArrayBuffer(content));
				}
			} else {
				// File exists but is not a TFile - check if it's a folder
				if (file instanceof TFolder) {
					throw new Error(`Cannot write file to ${path}: a folder with that name already exists`);
				}
				// Unknown type - future-proof for new Obsidian abstract file types
				throw new Error(`Cannot write file to ${path}: path exists but is not a file (type: ${file.constructor.name})`);
			}

			const change: FileChange = { path, type: file ? "MODIFIED" : "ADDED" };

			// Compute SHA from in-memory content if file should be tracked
			// See docs/sync-logic.md "SHA Computation from In-Memory Content" for rationale
			// For clash files: compute SHA for original path (pathForSha), not _fit/ path
			let shaPromise: Promise<BlobSha> | null = null;
			if (this.shouldTrackState(pathForSha)) {
				shaPromise = LocalVault.fileSha1(pathForSha, originalContent);
			}

			return { change, shaPromise };
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
	 * Delete a file
	 * @returns Record of file operation performed
	 */
	private async deleteFile(path: string): Promise<FileChange> {
		try {
			const file = this.vault.getAbstractFileByPath(path);
			if (file && file instanceof TFile) {
				await this.vault.delete(file);
				return {path, type: "REMOVED"};
			}
			throw new Error(`Attempting to delete ${path} from local but not successful, file is of type ${typeof file}.`);
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
	 * @param options.clashPaths - Set of paths that should be written as clash files.
	 *   Writes to `_fit/{path}` but computes SHA for original `{path}`.
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>,
		options?: { clashPaths?: Set<string> }
	): Promise<ApplyChangesResult<"local">> {
		const clashPaths = options?.clashPaths ?? new Set();
		// Diagnostic logging: detect suspicious filename correspondences (Issue #51)
		// Check if any files being created have non-ASCII chars and match existing local files
		// Note: vault.getFiles() may be unavailable in test mocks
		const allExistingPaths = this.vault.getFiles?.()?.map(f => f.path) ?? [];
		const suspiciousWrites: Array<{remote: string, local: string, pattern: string}> = [];

		for (const {path: remotePath} of filesToWrite) {
			// Only check files with non-ASCII characters that don't already exist
			if (!/[^\x00-\x7F]/.test(remotePath)) continue;
			if (this.vault.getAbstractFileByPath(remotePath)) continue;

			// Find correspondences with existing files
			const matches = findSuspiciousCorrespondences(remotePath, allExistingPaths);
			for (const match of matches) {
				suspiciousWrites.push({
					remote: match.candidate,
					local: match.existing,
					pattern: match.pattern
				});
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
				filesToWrite.map(async ({path, content}) => {
					// If path is in clashPaths, write to _fit/ subdirectory
					const writePath = clashPaths.has(path) ? `_fit/${path}` : path;
					// Always compute SHA for original path (not _fit/ path)
					return this.writeFile(writePath, content.toBase64(), content, path);
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
		const writeResults: Array<{change: FileChange, shaPromise?: Promise<BlobSha>}> = [];
		const writeFailures = collectSettledFailures(writeSettledResults, filesToWrite.map(f => f.path));

		for (let i = 0; i < writeSettledResults.length; i++) {
			const result = writeSettledResults[i];
			const {path} = filesToWrite[i];

			if (result.status === 'fulfilled') {
				const {change, shaPromise} = result.value;
				writeResults.push({ change, shaPromise: shaPromise ?? undefined });
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

		// If any operations failed, throw VaultError with details
		if (writeFailures.length > 0 || deleteFailures.length > 0) {
			const allFailures = [...writeFailures, ...deleteFailures];
			const failedPaths = allFailures.map(f => f.path);
			const primaryPath = failedPaths[0];
			const primaryError = allFailures[0].error;
			const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);

			throw VaultError.filesystem(
				`Failed to write to ${primaryPath}: ${primaryMessage}`,
				{
					failedPaths,
					errors: allFailures
				}
			);
		}

		// Extract file operations for return value
		const writeOps = writeResults.map(r => r.change);
		const changes = [...writeOps, ...deletionOps];

		// Collect SHA promises from write operations (started asynchronously in writeFile)
		// Map: path -> SHA promise (only for trackable files)
		const shaPromiseMap: Record<string, Promise<BlobSha>> = {};
		for (const result of writeResults) {
			if (result.shaPromise) {
				shaPromiseMap[result.change.path] = result.shaPromise;
			}
		}

		// Return SHA computations as promise for caller to await when ready
		// This allows SHA computation (CPU-intensive) to run in parallel with other sync operations
		const writtenStates = Promise.all(
			Object.entries(shaPromiseMap).map(async ([path, shaPromise]) => {
				const sha = await shaPromise;
				return [path, sha] as const;
			})
		).then(entries => Object.fromEntries(entries));

		return {
			changes,
			writtenStates,
			userWarning
		};
	}
}
