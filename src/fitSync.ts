import { Fit } from "./fit";
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteUpdate } from "./fitTypes";
import { extractExtension } from "./utils";
import { LocalStores } from "main";
import FitNotice from "./fitNotice";
import { SyncResult, SyncErrors, SyncError } from "./syncResult";
import { fitLogger } from "./logger";
import { VaultError } from "./vault";
import { Base64Content, FileContent, isBinaryExtension } from "./util/contentEncoding";
import { BlobSha, CommitSha } from "./util/hashing";

// Helper to log SHA cache updates with provenance tracking
function logCacheUpdate(
	source: string,
	oldLocalSha: Record<string, BlobSha>,
	newLocalSha: Record<string, BlobSha>,
	oldRemoteSha: Record<string, BlobSha>,
	newRemoteSha: Record<string, BlobSha>,
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

	fitLogger.log('[FitSync] Updating local store after ' + source, {
		source,
		oldLocalShaCount: oldLocalCount,
		newLocalShaCount: newLocalCount,
		oldRemoteShaCount: Object.keys(oldRemoteSha).length,
		newRemoteShaCount: Object.keys(newRemoteSha).length,
		localShaAdded,
		localShaRemoved,
		remoteShaAdded: Object.keys(newRemoteSha).filter(k => !oldRemoteSha[k]),
		remoteShaRemoved: Object.keys(oldRemoteSha).filter(k => !newRemoteSha[k]),
		commitShaChanged: oldCommitSha !== newCommitSha,
		oldCommitSha,
		newCommitSha,
		...(warnings.length > 0 && { warnings }),
		...extraContext
	});
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
 * Result of sync execution including operations applied and any conflicts.
 * Used by both low-level execution (executeSyncPlan) and high-level coordination (executeSync).
 *
 * The `conflicts` field may contain:
 * - Newly discovered conflicts (when returned from executeSyncPlan)
 * - All unresolved conflicts, both upfront and newly discovered (when returned from executeSync)
 */
type SyncExecutionResult = {
	/** Operations applied to local vault (from remote changes) */
	localOps: LocalChange[];
	/** Operations applied to remote (from local changes) */
	remoteOps: LocalChange[];
	/** Unresolved conflicts (context-dependent: new conflicts or all conflicts) */
	conflicts: ClashStatus[];
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


	constructor(fit: Fit, saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>) {
		this.fit = fit;
		this.saveLocalStoreCallback = saveLocalStoreCallback;
	}

	private generateConflictReport(path: string, localContent: Base64Content, remoteContent: Base64Content): ConflictReport {
		const detectedExtension = extractExtension(path);
		if (detectedExtension && isBinaryExtension(detectedExtension)) {
			return {
				path,
				resolutionStrategy: "binary",
				remoteContent
			};
		}
		// assume file encoding is utf8 if extension is not known
		// Note: Both localContent and remoteContent are Base64Content
		// For local: if it's a text file, localVault returns PlainTextContent, but we need to handle that upstream
		// For remote: remoteVault ALWAYS returns Base64Content
		return {
			path,
			resolutionStrategy: "utf-8",
			localContent,
			remoteContent,
		};
	}

	/**
	 * Prepare conflict file for writing to _fit/ directory.
	 * Returns the path and content, but doesn't write yet (caller batches all writes).
	 */
	private prepareConflictFile(path: string, content: Base64Content): { path: string, content: FileContent } {
		return {
			path: `_fit/${path}`,
			content: FileContent.fromBase64(content)
		};
	}

	private async resolveFileConflict(
		clash: ClashStatus,
		existenceMap?: Map<string, 'file' | 'folder' | 'nonexistent'>
	): Promise<ConflictResolutionResult> {
		if (clash.localStatus === "deleted" && clash.remoteStatus === "REMOVED") {
			return {path: clash.path};
		} else if (clash.localStatus === "deleted") {
			const remoteContent = await this.fit.remoteVault.readFileContent(clash.path);
			const conflictFile = this.prepareConflictFile(clash.path, remoteContent.toBase64());
			return {path: clash.path, conflictFile};
		} else if (clash.localStatus === "untracked") {
			// File is protected path or hidden - can't verify local state via tracking
			if (clash.remoteStatus === "REMOVED") {
				// Remote deleted, local untracked - check if file exists before deciding
				// Use stat map if provided, otherwise file might exist (conservative)
				const stat = existenceMap?.get(clash.path);
				const fileExists = stat === 'file' || stat === 'folder' || stat === undefined;

				if (!fileExists) {
					// File doesn't exist locally - deletion is a no-op
					fitLogger.log('[FitSync] Untracked file already deleted locally', {
						path: clash.path
					});
				}
				// Either file exists (don't delete) or doesn't exist (already deleted)
				return {path: clash.path};
			} else {
				const remoteContent = await this.fit.remoteVault.readFileContent(clash.path);

				// Protected paths (e.g., .obsidian/) should ALWAYS go to _fit/, never written directly
				if (!this.fit.shouldSyncPath(clash.path)) {
					const conflictFile = this.prepareConflictFile(clash.path, remoteContent.toBase64());
					return {path: clash.path, conflictFile};
				}

				// Unprotected but untracked (e.g., hidden files) - check if file actually exists locally
				// If it doesn't exist, we can write it directly instead of to _fit/
				const stat = existenceMap?.get(clash.path);
				const locallyExists = stat === 'file' || stat === 'folder' || stat === undefined;

				if (locallyExists) {
					// File exists locally (or unknown) - save remote version to _fit/ to avoid overwriting
					const conflictFile = this.prepareConflictFile(clash.path, remoteContent.toBase64());
					return {path: clash.path, conflictFile};
				} else {
					// File doesn't exist locally - safe to write directly
					// This is NOT a conflict - it's a remote add that can be applied directly
					fitLogger.log('[FitSync] Untracked file doesn\'t exist locally - will write directly (not a conflict)', {
						path: clash.path
					});
					return {
						path: clash.path,
						directWrite: { path: clash.path, content: remoteContent }
					};
				}
			}
		}

		const localFileContent = await this.fit.localVault.readFileContent(clash.path);

		// Remote file was modified (not deleted)
		if (clash.remoteStatus !== "REMOVED") {
			const remoteContent = await this.fit.remoteVault.readFileContent(clash.path);
			// TODO: Should we really need to force to base64 to compare, even if hypothetically both were already plaintext?
			const localBase64 = localFileContent.toBase64();
			const remoteBase64 = remoteContent.toBase64();

			if (remoteBase64 !== localBase64) {
				const report = this.generateConflictReport(clash.path, localBase64, remoteBase64);
				const conflictFile = this.prepareConflictFile(clash.path, report.remoteContent);
				return {path: clash.path, conflictFile};
			}
			return { path: clash.path };
		} else {
			// Remote file was deleted, local file has changes - no file to write but this is still a "conflict"
			// (User needs to be aware remote deleted their locally-changed file)
			return { path: clash.path };
		}
	}

	/**
	 * Apply remote changes to local vault with comprehensive safety checks.
	 * Handles protected paths, untracked files, and stat verification.
	 *
	 * @returns File operations performed and stat failure tracking
	 */
	private async applyRemoteChanges(
		addToLocalNonClashed: Array<{path: string, content: FileContent}>,
		deleteFromLocalNonClashed: string[],
		existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>,
		statError: unknown,
		filesMovedToFitDueToStatFailureClashes: string[],
		deletionsSkippedDueToStatFailureClashes: string[],
		syncNotice: FitNotice
	): Promise<{
		ops: FileOpRecord[],
		filesMovedToFitDueToStatFailure: string[],
		deletionsSkippedDueToStatFailure: string[]
	}> {
		syncNotice.setMessage("Writing remote changes to local");

		// Track files saved to _fit/ due to stat failures for consolidated logging
		const filesMovedToFitDueToStatFailure: string[] = [];

		const resolvedChanges: Array<{path: string, content: FileContent}> = [];
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
				resolvedChanges.push({
					path: `_fit/${change.path}`,
					content: change.content
				});
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
					filesMovedToFitDueToStatFailure.push(change.path);
					resolvedChanges.push({
						path: `_fit/${change.path}`,
						content: change.content
					});
					continue; // Don't risk overwriting if file might exist
				} else if (stat === 'file' || stat === 'folder') {
					// File exists - save to _fit/ for safety (tracking state inconsistency)
					resolvedChanges.push({
						path: `_fit/${change.path}`,
						content: change.content
					});
					continue; // Don't risk overwriting local version
				}
				// File doesn't exist locally (stat === 'nonexistent') - safe to write directly
			}

			// Normal file or no conflict - add as-is
			resolvedChanges.push({path: change.path, content: change.content});
		}

		// SAFETY: Never delete protected or untracked files from local
		// Track files where deletion was skipped due to stat failures
		const deletionsSkippedDueToStatFailure: string[] = [];

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
					deletionsSkippedDueToStatFailure.push(path);
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

		// Log consolidated stat failure information if any occurred
		const allFilesMovedToFit = [...filesMovedToFitDueToStatFailureClashes, ...filesMovedToFitDueToStatFailure];
		const allDeletionsSkipped = [...deletionsSkippedDueToStatFailureClashes, ...deletionsSkippedDueToStatFailure];
		if (statError !== null || allFilesMovedToFit.length > 0 || allDeletionsSkipped.length > 0) {
			fitLogger.log('[FitSync] Couldn\'t check if some paths exist locally - conservatively treating as clash', {
				error: statError,
				filesMovedToFit: allFilesMovedToFit,
				deletionsSkipped: allDeletionsSkipped
			});
		}

		const addToLocal = resolvedChanges;
		const deleteFromLocal = safeDeleteFromLocal;

		// Apply changes (filtered to save conflicts to _fit/)
		const ops = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

		return { ops, filesMovedToFitDueToStatFailure, deletionsSkippedDueToStatFailure };
	}

	/**
	 * Resolve all clashes by writing conflicted files to _fit/ directory.
	 * Tracks which files were affected by stat failures during resolution.
	 *
	 * @returns File operations performed, unresolved conflicts, and stat failure tracking
	 */
	private async resolveClashes(
		clashes: ClashStatus[],
		existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>,
		syncNotice: FitNotice
	): Promise<{
		ops: FileOpRecord[],
		unresolved: ClashStatus[],
		filesMovedToFitDueToStatFailure: string[],
		deletionsSkippedDueToStatFailure: string[]
	}> {
		if (clashes.length === 0) {
			return {
				ops: [],
				unresolved: [],
				filesMovedToFitDueToStatFailure: [],
				deletionsSkippedDueToStatFailure: []
			};
		}


		const fileResolutions = await Promise.all(
			clashes.map(async (clash) => {
				try {
					return await this.resolveFileConflict(clash, existenceMap);
				} catch (error) {
					fitLogger.log('[FitSync] Error resolving conflict for file', {
						path: clash.path,
						localStatus: clash.localStatus,
						remoteStatus: clash.remoteStatus,
						error: error instanceof Error ? error.message : String(error)
					});
					throw error;
				}
			}));

		// Track which files were affected by stat failures
		const filesMovedToFitDueToStatFailure: string[] = [];
		const deletionsSkippedDueToStatFailure: string[] = [];

		for (let i = 0; i < clashes.length; i++) {
			const clash = clashes[i];
			const res = fileResolutions[i];

			if (clash.localStatus === 'untracked') {
				const stat = existenceMap.get(clash.path);
				if (stat === undefined) {
					// Stat failed for this path
					if (clash.remoteStatus === 'REMOVED') {
						deletionsSkippedDueToStatFailure.push(clash.path);
					} else if (res.conflictFile && res.conflictFile.path.startsWith('_fit/')) {
						filesMovedToFitDueToStatFailure.push(clash.path);
					}
				}
			}
		}

		// conflictFile = written to _fit/ (user-facing conflict)
		// directWrite = written directly (safe, no conflict)
		const conflictFilesToWrite = fileResolutions
			.filter(r => r.conflictFile)
			.map(r => r.conflictFile!);

		const directWrites = fileResolutions
			.filter(r => r.directWrite)
			.map(r => r.directWrite!);

		// Conflicts are determined by presence of conflictFile (always goes to _fit/)
		const unresolved = fileResolutions
			.map((res, i) => res.conflictFile ? clashes[i] : null)
			.filter(Boolean) as Array<ClashStatus>;

		const ops: FileOpRecord[] = [];

		if (conflictFilesToWrite.length > 0) {
			const conflictOps = await this.fit.localVault.applyChanges(conflictFilesToWrite, []);
			ops.push(...conflictOps);
		}

		if (directWrites.length > 0) {
			const directOps = await this.fit.localVault.applyChanges(directWrites, []);
			ops.push(...directOps);
		}

		// Show "Change conflicts detected" notice if any conflicts will be written to _fit/
		if (conflictFilesToWrite.length > 0) {
			syncNotice.setMessage(`Change conflicts detected`);
		}

		return { ops, unresolved, filesMovedToFitDueToStatFailure, deletionsSkippedDueToStatFailure };
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
	 * Execute a sync plan: push local changes, pull remote changes, and persist state.
	 * This is the unified execution path for both compatible and conflicted syncs.
	 *
	 * The operation is atomic: if any step fails, no state is persisted.
	 *
	 * @returns The operations that were applied and any conflicts discovered during execution
	 */
	private async performSync(
		localChanges: LocalChange[],
		remoteUpdate: RemoteUpdate,
		currentLocalState: Record<string, BlobSha>,
		syncNotice: FitNotice
	): Promise<SyncExecutionResult> {
		// Phase 1: Detect all clashes between local and remote changes
		const clashes = this.fit.getClashedChanges(localChanges, remoteUpdate.remoteChanges);
		const clashPaths = new Set(clashes.map(c => c.path));

		// Separate clashed remote changes from non-clashed ones
		const remoteChangesToPull = remoteUpdate.remoteChanges.filter(c => !clashPaths.has(c.path));
		const localChangesToPush = localChanges; // Push all, including conflicted

		// Phase 2: Prepare non-clashed remote changes and collect filesystem state
		const deleteFromLocalNonClashed = remoteChangesToPull.filter(c => c.status === "REMOVED").map(c => c.path);
		const addToLocalNonClashed = await Promise.all(
			remoteChangesToPull
				.filter(c => c.status !== "REMOVED")
				.map(async (change) => ({
					path: change.path,
					content: await this.fit.remoteVault.readFileContent(change.path)
				}))
		);

		// Collect all paths that need filesystem existence checking across all phases
		const pathsToStat = new Set<string>();

		// From clashes: untracked files need stat checking
		clashes.filter(c => c.localStatus === 'untracked').forEach(c => pathsToStat.add(c.path));

		// From remote changes: files not in localSha need stat checking
		addToLocalNonClashed
			.filter(c => this.fit.shouldSyncPath(c.path))
			.filter(c => !this.fit.localSha.hasOwnProperty(c.path))
			.forEach(c => pathsToStat.add(c.path));
		deleteFromLocalNonClashed
			.filter(p => this.fit.shouldSyncPath(p))
			.filter(p => !this.fit.localSha.hasOwnProperty(p))
			.forEach(p => pathsToStat.add(p));

		// From local changes: deletions need verification (version migration safety)
		localChangesToPush
			.filter(c => c.status === 'deleted')
			.forEach(c => pathsToStat.add(c.path));

		// Batch stat all paths at once
		const {existenceMap, statError} = await this.collectFilesystemState(Array.from(pathsToStat));

		// Phase 3: Resolve all clashes (writes to _fit/ if needed)
		const {
			ops: resolvedConflictOps,
			unresolved: unresolvedConflicts,
			filesMovedToFitDueToStatFailure: filesMovedToFitDueToStatFailureClashes,
			deletionsSkippedDueToStatFailure: deletionsSkippedDueToStatFailureClashes
		} = await this.resolveClashes(clashes, existenceMap, syncNotice);

		if (clashes.length > 0) {
			fitLogger.log('[FitSync] Resolved clashes', {
				clashCount: clashes.length,
				unresolvedCount: unresolvedConflicts.length,
				filesWrittenToFit: resolvedConflictOps.length
			});
		}

		// Phase 4: Push local changes to remote
		syncNotice.setMessage("Uploading local changes");
		const pushUpdate = {
			localChanges: localChangesToPush,
			parentCommitSha: remoteUpdate.latestRemoteCommitSha
		};
		const pushResult = await this.pushChangedFilesToRemote(pushUpdate, existenceMap);

		fitLogger.log('[FitSync] Pushed local changes to remote', {
			changesPushed: pushResult?.pushedChanges.length ?? 0
		});

		let latestRemoteTreeSha: Record<string, BlobSha>;
		let latestCommitSha: CommitSha;
		let pushedChanges: Array<LocalChange>;

		if (pushResult) {
			latestRemoteTreeSha = pushResult.lastFetchedRemoteSha;
			latestCommitSha = pushResult.lastFetchedCommitSha;
			pushedChanges = pushResult.pushedChanges;
		} else {
			// No changes were pushed
			// TODO: Should we abort the sync if plan.localChangesToPush had changes but nothing was pushed?
			// This could indicate a push failure that we're silently ignoring. If we continue and persist
			// the new remote state, we might incorrectly mark those local changes as synced.
			latestRemoteTreeSha = remoteUpdate.remoteTreeSha;
			latestCommitSha = remoteUpdate.latestRemoteCommitSha;
			pushedChanges = [];
		}

		// Phase 5: Pull remote changes to local (with safety checks)
		const {ops: localFileOpsRecord} = await this.applyRemoteChanges(
			addToLocalNonClashed,
			deleteFromLocalNonClashed,
			existenceMap,
			statError,
			filesMovedToFitDueToStatFailureClashes,
			deletionsSkippedDueToStatFailureClashes,
			syncNotice
		);

		if (addToLocalNonClashed.length > 0 || deleteFromLocalNonClashed.length > 0) {
			fitLogger.log('[FitSync] Pulled remote changes to local', {
				filesWritten: addToLocalNonClashed.length,
				filesDeleted: deleteFromLocalNonClashed.length
			});
		}

		// Phase 6: Update local state using SHAs computed by LocalVault (performance optimization)
		// LocalVault computed SHAs from in-memory content during file writes (see docs/sync-logic.md).
		// Benefits: avoids redundant I/O, prevents race conditions, no normalization in Obsidian.
		// Only trackable files included (hidden files excluded to avoid spurious deletions).
		const writtenFileShas = await this.fit.localVault.getAndClearWrittenFileShas();

		// Update local state: start with current state, apply writes, remove deletes
		const newLocalState = {
			...currentLocalState, // Start with state from beginning of sync (includes all existing files)
			...writtenFileShas // Update SHAs for files we just wrote (only trackable ones)
		};

		// Remove deleted files from state
		for (const path of deleteFromLocalNonClashed) {
			delete newLocalState[path];
		}

		if (Object.keys(writtenFileShas).length > 0) {
			fitLogger.log('[FitSync] Updated local state with SHAs from written files', {
				filesProcessed: Object.keys(writtenFileShas).length,
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
			{ localOpsApplied: localFileOpsRecord.length, remoteOpsPushed: pushedChanges.length }
		);

		await this.saveLocalStoreCallback({
			lastFetchedRemoteSha: latestRemoteTreeSha, // Unfiltered - must track ALL remote files to detect changes
			lastFetchedCommitSha: latestCommitSha,
			localSha: this.fit.filterSyncedState(newLocalState)
		});

		return {
			localOps: localFileOpsRecord.concat(resolvedConflictOps),
			remoteOps: pushedChanges,
			conflicts: unresolvedConflicts
		};
	}

	async sync(syncNotice: FitNotice): Promise<SyncResult> {
		try {
			syncNotice.setMessage("Checking for changes...");

			// Get local changes and current local state (with SHAs already computed)
			const {changes: localChanges, state: currentLocalState} = await this.fit.getLocalChanges();
			const filteredLocalChanges = localChanges.filter(c => this.fit.shouldSyncPath(c.path));

			// Get remote changes (vault caching handles optimization)
			const {changes: remoteChanges, state: remoteTreeSha, commitSha: remoteCommitSha} = await this.fit.getRemoteChanges();

			// Log sync decision for diagnostics
			// Log all files involved upfront for crash diagnostics
			const logData: Record<string, Record<string, string[]>> = {};

			const localData: Record<string, string[]> = {};
			['created', 'changed', 'deleted'].forEach(status => {
				const files = filteredLocalChanges.filter(c => c.status === status).map(c => c.path);
				if (files.length > 0) localData[status] = files;
			});
			if (Object.keys(localData).length > 0) logData.local = localData;

			const remoteData: Record<string, string[]> = {};
			[['ADDED', 'added'], ['MODIFIED', 'modified'], ['REMOVED', 'removed']].forEach(([status, key]) => {
				const files = remoteChanges.filter(c => c.status === status).map(c => c.path);
				if (files.length > 0) remoteData[key] = files;
			});
			if (Object.keys(remoteData).length > 0) logData.remote = remoteData;

			fitLogger.log('[FitSync] Starting sync', logData);

			// Execute sync (handles all clash detection, push, pull, persist)
			const { localOps, remoteOps, conflicts } = await this.performSync(
				filteredLocalChanges,
				{
					remoteChanges,
					remoteTreeSha,
					latestRemoteCommitSha: remoteCommitSha
				},
				currentLocalState,
				syncNotice
			);

			// Log conflicts if any (these are real unresolved conflicts, not temporary clashes)
			if (conflicts.length > 0) {
				fitLogger.log('[FitSync] Sync completed with conflicts', {
					conflictCount: conflicts.length,
					conflicts: conflicts.map(c => ({
						path: c.path,
						local: c.localStatus,
						remote: c.remoteStatus
					}))
				});
			}

			// Set appropriate success message
			if (conflicts.length === 0) {
				syncNotice.setMessage(`Sync successful`);
			} else if (conflicts.some(f => f.remoteStatus !== "REMOVED")) {
				syncNotice.setMessage(`Synced with remote, unresolved conflicts written to _fit`);
			} else {
				syncNotice.setMessage(`Synced with remote, ignored remote deletion of locally changed files`);
			}

			return {
				success: true,
				ops: [
					{heading: "Local file updates:", ops: localOps},
					{heading: "Remote file updates:", ops: remoteOps},
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
		}
	}

	private async pushChangedFilesToRemote(
		localUpdate: LocalUpdate,
		existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>
	): Promise<{pushedChanges: LocalChange[], lastFetchedRemoteSha: Record<string, BlobSha>, lastFetchedCommitSha: CommitSha}|null> {
		if (localUpdate.localChanges.length === 0) {
			return null;
		}

		// Prepare files to write and delete by reading content from local vault
		const filesToWrite: Array<{path: string, content: FileContent}> = [];
		const filesToDelete: Array<string> = [];

		for (const change of localUpdate.localChanges) {
			if (change.status === 'deleted') {
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

		// Use remoteVault.applyChanges() to handle all GitHub operations
		const fileOps = await this.fit.remoteVault.applyChanges(filesToWrite, filesToDelete);

		// If no operations were performed, return null
		// This can happen when local SHA differs from cache but content matches remote
		// (spurious change due to SHA normalization or caching issues)
		if (fileOps.length === 0) {
			fitLogger.log('[FitSync] No remote changes needed - content already matches', {
				localChangesDetected: localUpdate.localChanges.length,
				reason: 'Local content matches remote despite SHA cache mismatch (likely SHA normalization or cache inconsistency)'
			});
			return null;
		}

		// Get updated state after push
		const { state: newRemoteState, commitSha: newRemoteCommitSha } = await this.fit.remoteVault.readFromSource();
		if (newRemoteCommitSha === undefined) {
			throw new Error('Missing expected commitSha from remote');
		}

		// Map fileOps back to original LocalChange format for return value
		const pushedChanges = fileOps.map(op => {
			const originalChange = localUpdate.localChanges.find(c => c.path === op.path);
			return originalChange || { path: op.path, status: op.status as LocalChange['status'] };
		});

		return {
			pushedChanges,
			lastFetchedRemoteSha: newRemoteState,
			lastFetchedCommitSha: newRemoteCommitSha,
		};
	}

	/**
	 * Generate user-friendly error message from structured sync error.
	 * Converts technical sync errors into messages appropriate for end users.
	 */
	getSyncErrorMessage(syncError: SyncError): string {
		// Handle VaultError types
		if (syncError instanceof VaultError) {
			switch (syncError.type) {
				case 'network':
					return `${syncError.message}. Please check your internet connection.`;
				case 'authentication':
					return `${syncError.message}. Check your GitHub personal access token.`;
				case 'remote_not_found':
					return `${syncError.message}. Check your repo and branch settings.`;
				case 'filesystem':
					return `File system error: ${syncError.message}`;
			}
		}

		// Handle sync orchestration errors (type === 'unknown')
		return syncError.detailMessage;
	}
}
