import { Fit } from "./fit";
import { FileChange, FileClash, FileStates, determineChecksNeeded, resolveAllChanges, resolveUntrackedState } from "./util/changeTracking";
import { LocalStores } from "@main";
import FitNotice from "./fitNotice";
import { SyncResult, SyncErrors, SyncError } from "./syncResult";
import { fitLogger } from "./logger";
import { ApplyChangesResult, VaultError } from "./vault";
import { Base64Content, FileContent } from "./util/contentEncoding";
import { detectNormalizationMismatches } from "./util/filePath";
import { BlobSha, CommitSha } from "./util/hashing";
import { LocalVault } from "./localVault";

// Helper to log SHA cache updates with provenance tracking
function logCacheUpdate(
	source: string,
	oldLocalSha: FileStates,
	newLocalSha: FileStates,
	oldRemoteSha: FileStates,
	newRemoteSha: FileStates,
	oldCommitSha: CommitSha | null | undefined,
	newCommitSha: CommitSha,
	extraContext?: Record<string, unknown>
) {
	const oldLocalCount = Object.keys(oldLocalSha).length;
	const newLocalCount = Object.keys(newLocalSha).length;
	const localShaAdded = Object.keys(newLocalSha).filter(k => !oldLocalSha[k]);
	const localShaRemoved = Object.keys(oldLocalSha).filter(k => !newLocalSha[k]);
	const warnings: string[] = [];

	// Warn if cache went from non-empty to empty (possible data loss)
	if (oldLocalCount > 0 && newLocalCount === 0) {
		warnings.push(`Local SHA cache dropped from ${oldLocalCount} to 0 files - possible data corruption`);
	}

	// Warn if large number of files suddenly appeared (possible cache was cleared then repopulated)
	if (oldLocalCount === 0 && newLocalCount > 10) {
		warnings.push(`Local SHA cache jumped from 0 to ${newLocalCount} files - possible recovery from empty cache or first sync`);
	}

	const totalChanges = localShaAdded.length + localShaRemoved.length +
		Object.keys(newRemoteSha).filter(k => !oldRemoteSha[k]).length +
		Object.keys(oldRemoteSha).filter(k => !newRemoteSha[k]).length;

	if (totalChanges > 0 || oldCommitSha !== newCommitSha || warnings.length > 0) {
		fitLogger.log(`.. 📦 [Cache] Updating SHA cache after ${source}`, {
			localChanges: localShaAdded.length + localShaRemoved.length,
			remoteChanges: Object.keys(newRemoteSha).filter(k => !oldRemoteSha[k]).length + Object.keys(oldRemoteSha).filter(k => !newRemoteSha[k]).length,
			commitChanged: oldCommitSha !== newCommitSha,
			...(warnings.length > 0 && { warnings }),
			...extraContext
		});
	}
}

/**
 * Interface for the sync orchestrator.
 *
 * FitSync is the high-level coordinator for all sync operations between local
 * vault and remote GitHub repository. It's the main entry point for triggering
 * sync and handles all the decision logic about what type of sync to perform.
 *
 * @see FitSync - The concrete implementation
 */
export interface IFitSync {
	fit: Fit
}

/**
 * Result of sync execution (Phase 3) including operations applied and any conflicts.
 *
 * Returned by executeSync() after pushing local changes, pulling remote changes,
 * and persisting state. The `conflicts` field contains clashes that were written to _fit/.
 */
type SyncExecutionResult = {
	/** Operations applied to local vault (from remote changes) */
	localOps: FileChange[];
	/** Operations applied to remote (from local changes) */
	remoteOps: FileChange[];
	/** Unresolved conflicts (context-dependent: new conflicts or all conflicts) */
	conflicts: FileClash[];
};

export type ConflictResolutionResult = {
	path: string;
	conflictFile?: { path: string; content: FileContent; }; // Conflict to write to _fit/ (always _fit/ prefixed)
};

/**
 * Sync orchestrator - coordinates all sync operations between local and remote.
 *
 * FitSync is the **main entry point** for synchronization. It:
 * - Detects local and remote changes
 * - Coordinates conflict resolution when both sides changed the same files
 * - Categorizes errors into user-friendly messages
 *
 * Architecture:
 * - **Role**: High-level orchestrator and decision maker
 * - **Used by**: FitPlugin (main.ts) - the Obsidian plugin entry point
 * - **Uses**: Fit (data access)
 *
 * Key responsibilities:
 * - Change detection: Scan local and remote for changes
 * - Conflict detection: Identify files changed on both sides
 * - Conflict resolution: Write conflicting files to _fit/ for user review
 * - Error handling: Catch all errors and categorize them (network, auth, filesystem, etc.)
 * - State updates: Update cached SHAs after successful sync
 *
 * @see sync() - The main entry point method
 * @see Fit - Data access layer for local and remote storage
 */
export class FitSync implements IFitSync {
	fit: Fit;
	saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>;
	private isSyncing = false;


	constructor(fit: Fit, saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>) {
		this.fit = fit;
		this.saveLocalStoreCallback = saveLocalStoreCallback;
	}

	/**
	 * Prepare conflict file for writing to _fit/ directory.
	 * Returns the ORIGINAL path (not prefixed) - caller adds to clashPaths set.
	 * This enables correct SHA keying by original path (issue #169).
	 */
	private prepareConflictFile(path: string, content: Base64Content): { path: string, content: FileContent } {
		return {
			path: path,  // Return original path, not _fit/ prefixed
			content: FileContent.fromBase64(content)
		};
	}

	/**
	 * Apply remote changes to local vault with comprehensive safety checks.
	 * Handles protected paths, untracked files, clashes, and stat verification.
	 *
	 * @param clashFiles - Conflict files to write to _fit/ (from clash detection)
	 * @returns File operations performed and stat failure tracking
	 */
	private async applyRemoteChanges(
		addToLocalNonClashed: Array<{path: string, content: FileContent}>,
		deleteFromLocalNonClashed: string[],
		clashFiles: Array<{path: string, content: FileContent}>,
		existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>,
		syncNotice: FitNotice
	): Promise<ApplyChangesResult<"local">> {
		if (clashFiles.length > 0) {
			syncNotice.setMessage('Change conflicts detected');
		} else {
			syncNotice.setMessage("Writing remote changes to local");
		}

		const resolvedChanges: Array<{path: string, content: FileContent}> = [];
		const clashPaths = new Set<string>(); // Track which paths should go to _fit/

		// Add all clash files to clashPaths set and resolvedChanges.
		// The clashPaths set tells applyChanges to write to _fit/ AND compute SHA using original path.
		for (const clashFile of clashFiles) {
			clashPaths.add(clashFile.path);
			resolvedChanges.push(clashFile);
		}

		for (const change of addToLocalNonClashed) {
			// SAFETY: Save protected paths to _fit/ (e.g., .obsidian/, _fit/)
			// These paths should never be written directly to the vault to avoid:
			// - Overwriting critical Obsidian settings/plugins (.obsidian/)
			// - Conflicting with our conflict resolution area (_fit/)
			// - User confusion from inconsistent behavior (_fit/_fit/ for remote _fit/ files)
			if (!this.fit.shouldSyncPath(change.path)) {
				fitLogger.log('[FitSync] Protected path - saving to _fit/ for safety', {
					path: change.path,
					reason: 'path excluded by shouldSyncPath (e.g., .obsidian/, _fit/)'
				});
				clashPaths.add(change.path);
				resolvedChanges.push(change);
				continue; // Don't write to protected path
			}

			// SAFETY: Check filesystem for files not in localSha cache
			// This protects against:
			// 1. Version migrations where tracking rules changed
			// 2. Bugs where shouldTrackState returns wrong value
			// 3. Hidden files that weren't tracked but exist locally
			//
			// If file not in cache but exists on disk → treat as clash, save to _fit/
			// If file not in cache and doesn't exist → safe to write directly
			if (!this.fit.localSha.hasOwnProperty(change.path)) {
				// Not in cache - check if file exists using statPaths result
				const stat = existenceMap.get(change.path);
				if (stat === undefined) {
					// Could not verify file existence - be conservative and save to _fit/
					// Note: This shouldn't happen if Phase 2 checked all needed paths
					clashPaths.add(change.path);
					resolvedChanges.push(change);
					continue; // Don't risk overwriting if file might exist
				} else if (stat === 'file' || stat === 'folder') {
					// File exists - save to _fit/ for safety (tracking state inconsistency)
					clashPaths.add(change.path);
					resolvedChanges.push(change);
					continue; // Don't risk overwriting local version
				}
				// File doesn't exist locally (stat === 'nonexistent') - safe to write directly
			}

			// Normal file or no conflict - add as-is
			resolvedChanges.push({path: change.path, content: change.content});
		}

		// SAFETY: Never delete protected or untracked files from local
		const safeDeleteFromLocal = [];
		for (const path of deleteFromLocalNonClashed) {
			// Skip deletion of protected paths (shouldn't exist locally, but be safe)
			if (!this.fit.shouldSyncPath(path)) {
				fitLogger.log('[FitSync] Skipping deletion of protected path', {
					path,
					reason: 'path excluded by shouldSyncPath (e.g., .obsidian/, _fit/)'
				});
				continue; // Skip deletion
			}

			// SAFETY: Check if file is in cache before deleting
			// If not in cache, we cannot verify it's safe to delete
			if (!this.fit.localSha.hasOwnProperty(path)) {
				// Not in cache - check if file actually exists to determine appropriate action
				// Use the existenceMap we already computed above
				const stat = existenceMap.get(path);
				if (stat === undefined) {
					// Could not verify file existence - be conservative and skip deletion
					// Note: This shouldn't happen if Phase 2 checked all needed paths
					continue; // Don't delete if we can't verify it's safe
				} else if (stat === 'file' || stat === 'folder') {
					// File exists but not tracked - don't delete (tracking state inconsistency)
					continue; // Skip deletion
				}
				// File doesn't exist (stat === 'nonexistent') - deletion already done, no action needed
				continue; // Skip deletion (no-op)
			}

			safeDeleteFromLocal.push(path); // Safe to delete
		}

		const addToLocal = resolvedChanges;
		const deleteFromLocal = safeDeleteFromLocal;

		// Apply changes with clashPaths to write protected/unsafe paths to _fit/
		const result = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal, { clashPaths });

		// Show user warning if encoding issues detected
		if (result.userWarning) {
			const warningNotice = new FitNotice(this.fit, [], result.userWarning, 0);
			warningNotice.show();
		}

		return result;
	}

	/**
	 * Collect filesystem existence state for all paths that need verification.
	 * This batches all stat operations into a single call for efficiency.
	 *
	 * @returns Map of path → existence state, plus any stat error encountered
	 */
	private async collectFilesystemState(
		paths: string[]
	): Promise<{existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>, statError: unknown}> {
		let existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>;
		let statError: unknown = null;
		try {
			const rawStatMap = await this.fit.localVault.statPaths(paths);
			existenceMap = new Map(
				Array.from(rawStatMap.entries()).map(([path, stat]) =>
					[path, stat === null ? 'nonexistent' : stat] as const
				)
			);
		} catch (error) {
			statError = error;
			// Leave map empty - all lookups will return undefined (unknown state)
			existenceMap = new Map();
		}

		return { existenceMap, statError };
	}

	/**
	 * Phase 2: Compare & Resolve changes to determine safe vs clashed operations.
	 *
	 * Performs the full Phase 2 workflow:
	 * - 2a: Determine what filesystem checks are needed
	 * - 2b: Batch collect filesystem state for verification
	 * - 2c: Resolve all changes to final safe/clash categorization
	 * - Log any stat failures that caused conservative clash treatment
	 *
	 * @returns Safe changes, clashes, and filesystem state for Phase 3 execution
	 */
	private async compareAndResolveChanges(
		localChanges: FileChange[],
		remoteChanges: FileChange[],
		localScanPaths: Set<string>,
		remoteScanPaths: Set<string>
	) {
		// Diagnostic: Check if any clashes are due to Unicode normalization mismatches
		detectNormalizationMismatches(Array.from(localScanPaths), Array.from(remoteScanPaths));

		// Phase 2a: Determine what filesystem checks are needed
		const { needsFilesystemCheck } = determineChecksNeeded(
			localChanges,
			remoteChanges,
			localScanPaths
		);

		// Phase 2b: Batch collect filesystem state for all paths needing verification
		const pathsToStat = new Set<string>();
		needsFilesystemCheck.forEach(item => pathsToStat.add(item.path));

		// Also check local deletions for version migration safety
		localChanges
			.filter(c => c.type === 'REMOVED')
			.forEach(c => pathsToStat.add(c.path));

		const { existenceMap, statError } = await this.collectFilesystemState(Array.from(pathsToStat));

		// Convert existenceMap to format expected by resolveAllChanges (true/false/null)
		// existenceMap values: "file" | "folder" | "nonexistent" | undefined
		const filesystemState = new Map<string, boolean | null>();
		for (const path of pathsToStat) {
			const state = existenceMap.get(path);
			if (state === undefined) {
				filesystemState.set(path, null); // stat failed
			} else {
				filesystemState.set(path, state !== "nonexistent");
			}
		}

		// Phase 2b (continued): Batch SHA reads for untracked files with baselines (#169)
		// For files that exist locally AND have a baseline SHA, read and compute current SHA
		// This allows baseline comparison to prevent unnecessary clashes
		const pathsNeedingShaCheck = Array.from(pathsToStat).filter(path =>
			filesystemState.get(path) === true &&
			this.fit.localSha[path] !== undefined
		);

		const currentShas = new Map<string, BlobSha>();
		for (const path of pathsNeedingShaCheck) {
			try {
				const content = await this.fit.localVault.readFileContent(path);
				const sha = await LocalVault.fileSha1(path, content);
				currentShas.set(path, sha);
			} catch (error) {
				// If we can't read the file for SHA computation, skip it
				// The file will be treated as changed (conservative behavior)
				fitLogger.log(`⚠️ [FitSync] Could not read file for SHA check: ${path}`, error);
			}
		}

		// Phase 2b (part 2): Resolve untracked state from filesystem checks
		const localChangePaths = new Set(localChanges.map(c => c.path));
		const isProtectedPath = (path: string) => !this.fit.shouldSyncPath(path);
		const { untrackedLocalChanges, blockedPaths } = resolveUntrackedState(
			remoteChanges,
			localChangePaths,
			filesystemState,
			this.fit.localSha,
			currentShas,
			isProtectedPath
		);

		// Combine tracked and untracked local changes
		const completeLocalChanges = [...localChanges, ...untrackedLocalChanges];

		// Phase 2c: Simple clash detection
		const shouldBlockRemote = (path: string) => blockedPaths.has(path);
		const { safeLocal, safeRemote, clashes } = resolveAllChanges(
			completeLocalChanges,
			remoteChanges,
			shouldBlockRemote
		);

		// Track stat failures for logging
		const filesMovedToFitDueToStatFailure: string[] = [];
		const deletionsSkippedDueToStatFailure: string[] = [];
		for (const clash of clashes) {
			if (clash.localState === 'untracked') {
				const stat = filesystemState.get(clash.path);
				if (stat === null) {
					// Stat failed - conservative clash
					if (clash.remoteOp === 'REMOVED') {
						deletionsSkippedDueToStatFailure.push(clash.path);
					} else {
						filesMovedToFitDueToStatFailure.push(clash.path);
					}
				}
			}
		}

		// Log consolidated stat failures
		if (statError !== null || filesMovedToFitDueToStatFailure.length > 0 ||
			deletionsSkippedDueToStatFailure.length > 0) {
			fitLogger.log('[FitSync] Couldn\'t check if some paths exist locally - conservatively treating as clash', {
				error: statError,
				filesMovedToFit: filesMovedToFitDueToStatFailure,
				deletionsSkipped: deletionsSkippedDueToStatFailure
			});
		}

		fitLogger.log('[FitSync] Conflict detection complete', {
			safeLocal: safeLocal.length,
			safeRemote: safeRemote.length,
			clashes: clashes.length
		});

		return {
			safeLocal, safeRemote, clashes, statError, filesMovedToFitDueToStatFailure, deletionsSkippedDueToStatFailure, existenceMap
		};
	}

	/**
	 * Phase 3: Execute sync operations - push, pull, persist state.
	 *
	 * Takes the resolved safe/clash categorization from Phase 2 and executes:
	 * - Write clashes to _fit/ directory
	 * - Push safe local changes to remote
	 * - Pull safe remote changes to local
	 * - Persist updated state (atomic - if any step fails, no state is saved)
	 *
	 * @returns The operations that were applied and conflicts discovered
	 */
	private async executeSync(
		currentLocalState: FileStates,
		remoteUpdate: { remoteChanges?: FileChange[]; remoteTreeSha: FileStates; latestRemoteCommitSha: CommitSha; },
		safeLocal: FileChange[],
		safeRemote: FileChange[],
		clashes: FileClash[],
		existenceMap: Map<string, "file" | "folder" | "nonexistent">,
		syncNotice: FitNotice
	): Promise<SyncExecutionResult> {
		// Prepare safe remote changes for pulling
		const deleteFromLocalNonClashed = safeRemote.filter(c => c.type === "REMOVED").map(c => c.path);
		const addToLocalNonClashed = await Promise.all(
			safeRemote
				.filter(c => c.type !== "REMOVED")
				.map(async (change) => ({
					path: change.path,
					content: await this.fit.remoteVault.readFileContent(change.path)
				}))
		);

		// Phase 3: Execute sync operations
		// Prepare clash files for writing to _fit/ directory
		const clashFiles = await Promise.all(
			clashes
				.filter(c => c.remoteOp !== 'REMOVED') // Skip deletions
				.map(async (clash) => {
					const content = await this.fit.remoteVault.readFileContent(clash.path);
					return this.prepareConflictFile(clash.path, content.toBase64());
				})
		);

		// 3a. Push local changes to remote
		syncNotice.setMessage("Uploading local changes");
		const pushUpdate = {
			localChanges: safeLocal,
			parentCommitSha: remoteUpdate.latestRemoteCommitSha
		};
		const pushResult = await this.pushChangedFilesToRemote(pushUpdate, existenceMap);

		if (pushResult && pushResult.pushedChanges.length > 0) {
			fitLogger.log(`.. ⬆️ [Push] Pushed ${pushResult.pushedChanges.length} changes to remote`);
		}

		let latestRemoteTreeSha: FileStates;
		let latestCommitSha: CommitSha;
		let pushedChanges: Array<FileChange>;

		if (pushResult) {
			latestRemoteTreeSha = pushResult.lastFetchedRemoteSha;
			latestCommitSha = pushResult.lastFetchedCommitSha;
			pushedChanges = pushResult.pushedChanges;
		} else {
			// No changes were pushed (pushChangedFilesToRemote returned null)
			// TODO: Should we abort the sync if safeLocal had changes but nothing was pushed?
			// This could indicate a push failure that we're silently ignoring. If we continue and persist
			// the new remote state, we might incorrectly mark those local changes as synced.
			latestRemoteTreeSha = remoteUpdate.remoteTreeSha;
			latestCommitSha = remoteUpdate.latestRemoteCommitSha;
			pushedChanges = [];
		}

		// 3b. Pull remote changes to local (with safety checks and clash resolution)
		const localFileOpsRecord = await this.applyRemoteChanges(
			addToLocalNonClashed,
			deleteFromLocalNonClashed,
			clashFiles,
			existenceMap,
			syncNotice
		);

		if (addToLocalNonClashed.length > 0 || deleteFromLocalNonClashed.length > 0 || clashFiles.length > 0) {
			fitLogger.log('.. ⬇️ [Pull] Applied remote changes to local', {
				filesWritten: addToLocalNonClashed.length,
				filesDeleted: deleteFromLocalNonClashed.length,
				clashesWrittenToFit: clashFiles.length
			});
		}

		// 3c. Update local state using SHAs computed by LocalVault (performance optimization)
		// LocalVault computed SHAs from in-memory content during file writes (see docs/sync-logic.md).
		// Benefits: avoids redundant I/O, prevents race conditions, no normalization in Obsidian.
		// Only trackable files included (hidden files excluded to avoid spurious deletions).
		// Note: We await the SHA promise here (not earlier) to allow parallel computation with other sync operations.
		const newBaselineShas = await localFileOpsRecord.newBaselineStates;

		// Update local state: start with current state, apply writes, remove deletes
		const newLocalState = {
			...currentLocalState, // Start with state from beginning of sync (includes all existing files)
			...newBaselineShas // Update SHAs for all files written (non-clashed + clashes) (#169)
		};

		// Remove deleted files from state
		for (const path of deleteFromLocalNonClashed) {
			delete newLocalState[path];
		}

		if (Object.keys(newBaselineShas).length > 0) {
			fitLogger.log('[FitSync] Updated local state with SHAs from written files', {
				filesProcessed: Object.keys(newBaselineShas).length,
				totalFilesInState: Object.keys(newLocalState).length
			});
		}

		logCacheUpdate(
			'sync',
			this.fit.localSha || {},
			newLocalState,
			this.fit.lastFetchedRemoteSha || {},
			latestRemoteTreeSha,
			this.fit.lastFetchedCommitSha,
			latestCommitSha,
			{ localOpsApplied: localFileOpsRecord.changes.length, remoteOpsPushed: pushedChanges.length }
		);

		await this.saveLocalStoreCallback({
			lastFetchedRemoteSha: latestRemoteTreeSha, // Unfiltered - must track ALL remote files to detect changes
			lastFetchedCommitSha: latestCommitSha,
			// TODO: Remove filterSyncedState after fixing bug where remote _fit/ files are passed to applyChanges
			// Currently remote _fit/ paths bypass shouldSyncPath filtering and get SHAs computed.
			// Once fixed, newBaselineStates will only contain syncable paths (no filtering needed).
			localSha: this.fit.filterSyncedState(newLocalState)
		});

		return {
			localOps: localFileOpsRecord.changes,
			remoteOps: pushedChanges,
			conflicts: clashes
		};
	}

	async sync(syncNotice: FitNotice): Promise<SyncResult> {
		// Check if already syncing
		if (this.isSyncing) {
			fitLogger.log('[FitSync] Sync already in progress - aborting new sync request');
			return { success: false, error: SyncErrors.alreadySyncing() };
		}

		this.isSyncing = true;

		try {
			syncNotice.setMessage("Checking for changes...");

			// Get local and remote changes in parallel
			// Use allSettled to ensure both operations complete (or fail) before processing
			// This prevents out-of-order logging when one operation fails quickly
			fitLogger.log('🔄 [Sync] Checking local and remote changes (parallel)...');
			const results = await Promise.allSettled([
				this.fit.getLocalChanges(),
				this.fit.getRemoteChanges()
			]);

			// Check for failures and throw the first error encountered
			const [localResult, remoteResult] = results;
			if (localResult.status === 'rejected') {
				throw localResult.reason;
			}
			if (remoteResult.status === 'rejected') {
				throw remoteResult.reason;
			}

			// Both succeeded, extract values
			const {changes: localChanges, state: currentLocalState} = localResult.value;
			const {changes: remoteChanges, state: remoteTreeSha, commitSha: remoteCommitSha} = remoteResult.value;
			fitLogger.log('.. ✅ [Sync] Change detection complete');
			const filteredLocalChanges = localChanges.filter(c => this.fit.shouldSyncPath(c.path));

			// Log detected changes for diagnostics
			const localCount = filteredLocalChanges.length;
			const remoteCount = remoteChanges.length;

			if (localCount > 0 || remoteCount > 0) {
				const logData: Record<string, Record<string, string[]>> = {};

				if (localCount > 0) {
					const localData: Record<string, string[]> = {};
					['ADDED', 'MODIFIED', 'REMOVED'].forEach(changeType => {
						const files = filteredLocalChanges.filter(c => c.type === changeType).map(c => c.path);
						if (files.length > 0) localData[changeType] = files;
					});
					logData.local = localData;
				}

				if (remoteCount > 0) {
					const remoteData: Record<string, string[]> = {};
					['ADDED', 'MODIFIED', 'REMOVED'].forEach(changeType => {
						const files = remoteChanges.filter(c => c.type === changeType).map(c => c.path);
						if (files.length > 0) remoteData[changeType] = files;
					});
					logData.remote = remoteData;
				}

				fitLogger.log(`🔄 [FitSync] Syncing changes (${localCount} local, ${remoteCount} remote)`, logData);
			}

			// Phase 2: Compare & Resolve - determine safe vs clashed changes
			const localScanPaths = new Set(Object.keys(currentLocalState));
			const remoteScanPaths = new Set(Object.keys(remoteTreeSha));
			const { safeLocal, safeRemote, clashes, existenceMap } = await this.compareAndResolveChanges(
				filteredLocalChanges,
				remoteChanges,
				localScanPaths,
				remoteScanPaths
			);

			// Phase 3: Execute - push, pull, persist (atomic operation)
			const { localOps, remoteOps, conflicts } = await this.executeSync(
				currentLocalState,
				{
					remoteChanges,
					remoteTreeSha,
					latestRemoteCommitSha: remoteCommitSha
				},
				safeLocal,
				safeRemote,
				clashes,
				existenceMap,
				syncNotice
			);

			// Log conflicts if any (these are real unresolved conflicts, not temporary clashes)
			if (conflicts.length > 0) {
				fitLogger.log('[FitSync] Sync completed with conflicts', {
					conflictCount: conflicts.length,
					conflicts: conflicts.map(c => ({
						path: c.path,
						local: c.localState,
						remote: c.remoteOp
					}))
				});
			}

			// Set appropriate success message
			if (conflicts.length === 0) {
				syncNotice.setMessage(`Sync successful`);
			} else if (conflicts.some(f => f.remoteOp !== "REMOVED")) {
				syncNotice.setMessage(`Synced with remote, unresolved conflicts written to _fit`);
			} else {
				syncNotice.setMessage(`Synced with remote, ignored remote deletion of locally changed files`);
			}

			return {
				success: true,
				changeGroups: [
					{heading: "Local file updates:", changes: localOps},
					{heading: "Remote file updates:", changes: remoteOps},
				],
				clash: conflicts
			};

		} catch (error) {
			// Handle unexpected errors that escape from individual sync operations.

			// VaultError from vault operations (both LocalVault and RemoteGitHubVault)
			if (error instanceof VaultError) {
				return { success: false, error };
			}

			// All other errors - sync orchestration failures
			const errorMessage = error instanceof Error
				? String(error) // Gets "ErrorType: message" which includes both type and message
				: (error && typeof error === 'object' && error.message)
					? String(error.message)
					: `Generic error: ${String(error)}`; // May result in '[object Object]' but it's the best we can do
			return { success: false, error: SyncErrors.unknown(errorMessage, { originalError: error }) };
		} finally {
			this.isSyncing = false;
		}
	}

	private async pushChangedFilesToRemote(
		localUpdate: {
			localChanges: FileChange[],
			parentCommitSha: CommitSha
		},
		existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>
	): Promise<{pushedChanges: FileChange[], lastFetchedRemoteSha: FileStates, lastFetchedCommitSha: CommitSha}|null> {
		if (localUpdate.localChanges.length === 0) {
			return null;
		}

		// Prepare files to write and delete by reading content from local vault
		const filesToWrite: Array<{path: string, content: FileContent}> = [];
		const filesToDelete: Array<string> = [];

		for (const change of localUpdate.localChanges) {
			if (change.type === 'REMOVED') {
				// SAFEGUARD: Verify file physically absent before deleting from remote
				// Prevents data loss when filtering rules change between versions
				const existence = existenceMap.get(change.path);

				// Only proceed with deletion if we KNOW the file doesn't exist
				// If stat failed (undefined) or file exists, skip deletion (fail-safe)
				if (existence !== 'nonexistent') {
					fitLogger.log('[FitSync] Skipping deletion - couldn\'t confirm local file actually deleted', {
						path: change.path,
						existence,
						reason: existence === undefined
							? 'Could not verify file absence (stat failed or path not checked)'
							: 'File present on filesystem but absent from state cache (likely filtering rule change)'
					});
					continue; // Don't delete from remote
				}
				filesToDelete.push(change.path);
			} else {
				const content = await this.fit.localVault.readFileContent(change.path);
				filesToWrite.push({ path: change.path, content });
			}
		}

		const result = await this.fit.remoteVault.applyChanges(filesToWrite, filesToDelete, { clashPaths: new Set() });

		// Show user warning if encoding issues detected during upload
		if (result.userWarning) {
			const warningNotice = new FitNotice(this.fit, [], result.userWarning, 0);
			warningNotice.show();
		}

		// If no operations were performed, return null
		// This can happen when local SHA differs from cache but content matches remote
		// (spurious change due to SHA normalization or caching issues)
		if (result.changes.length === 0) {
			fitLogger.log('[FitSync] No remote changes needed - content already matches', {
				localChangesDetected: localUpdate.localChanges.length,
				reason: 'Local content matches remote despite SHA cache mismatch (likely SHA normalization or cache inconsistency)'
			});
			return null;
		}

		const pushedChanges = result.changes.map(op => {
			const originalChange = localUpdate.localChanges.find(c => c.path === op.path);
			return originalChange || { path: op.path, type: op.type };
		});

		return {
			pushedChanges,
			lastFetchedRemoteSha: result.newState,
			lastFetchedCommitSha: result.commitSha,
		};
	}

	/**
	 * Generate user-friendly error message from structured sync error.
	 * Converts technical sync errors into messages appropriate for end users.
	 */
	getSyncErrorMessage(syncError: SyncError): string {
		let baseMessage: string;

		// Handle VaultError types (thrown by LocalVault and RemoteGitHubVault)
		if (syncError instanceof VaultError) {
			switch (syncError.type) {
				case 'network':
					baseMessage = `${syncError.message}. Please check your internet connection.`;
					break;
				case 'authentication':
					baseMessage = `${syncError.message}. Check your GitHub personal access token.`;
					break;
				case 'remote_not_found':
					baseMessage = `${syncError.message}. Check your repo and branch settings.`;
					break;
				case 'filesystem':
					baseMessage = `File system error: ${syncError.message}`;
					break;
			}

			// Append per-file error details if available
			if (syncError.details?.errors && syncError.details.errors.length > 0) {
				const errorEntries = syncError.details.errors;
				if (errorEntries.length <= 3) {
					// Show all errors with details for small counts
					baseMessage += '\n\nFailed files:';
					for (const { path, error } of errorEntries) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						// Show only first line for multi-line errors (full error in console/logs)
						const displayMsg = errorMsg.split('\n')[0];
						baseMessage += `\n  • ${path}: ${displayMsg}`;
					}
				} else {
					// Show first 3 with details, then summarize rest
					baseMessage += `\n\nFailed files (${errorEntries.length} total):`;
					for (let i = 0; i < 3; i++) {
						const { path, error } = errorEntries[i];
						const errorMsg = error instanceof Error ? error.message : String(error);
						const displayMsg = errorMsg.split('\n')[0];
						baseMessage += `\n  • ${path}: ${displayMsg}`;
					}
					baseMessage += `\n  • ... and ${errorEntries.length - 3} more`;
				}

				// Add recovery guidance for per-file errors
				baseMessage += '\n\n💡 To sync other files: Move problematic file(s) out of your vault temporarily, or use git to sync them manually. .gitignore support coming soon.';
			}
		} else {
			// Handle SyncOrchestrationError (type === 'unknown' | 'already-syncing')
			baseMessage = syncError.detailMessage;
		}

		return baseMessage;
	}
}
