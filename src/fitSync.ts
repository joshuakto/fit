import { Fit } from "./fit";
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteUpdate } from "./fitTypes";
import { extractExtension, removeLineEndingsFromBase64String } from "./utils";
import { LocalStores } from "main";
import FitNotice from "./fitNotice";
import { SyncResult, SyncErrors, SyncError } from "./syncResult";
import { fitLogger } from "./logger";
import { VaultError } from "./vault";
import { Base64Content, FileContent, isBinaryExtension } from "./contentEncoding";

// Helper to log SHA cache updates with provenance tracking
function logCacheUpdate(
	source: string,
	oldLocalSha: Record<string, string>,
	newLocalSha: Record<string, string>,
	oldRemoteSha: Record<string, string>,
	newRemoteSha: Record<string, string>,
	oldCommitSha: string | null | undefined,
	newCommitSha: string,
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

	private async handleBinaryConflict(path: string, remoteContent: Base64Content): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteContent);
	}

	private async handleUTF8Conflict(path: string, localContent: Base64Content, remoteConent: Base64Content): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteConent);
	}

	private async handleLocalDeletionConflict(path: string, remoteContent: Base64Content): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteContent);
	}

	async resolveFileConflict(
		clash: ClashStatus,
		latestRemoteFileSha: string,
		existenceMap?: Map<string, 'file' | 'folder' | 'nonexistent'>
	): Promise<ConflictResolutionResult> {
		if (clash.localStatus === "deleted" && clash.remoteStatus === "REMOVED") {
			return {path: clash.path, noDiff: true};
		} else if (clash.localStatus === "deleted") {
			const remoteContent = await this.fit.remoteVault.readFileContent(latestRemoteFileSha);
			const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent.toBase64());
			return {path: clash.path, noDiff: false, fileOp: fileOp};
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
				// Either file exists (don't delete) or doesn't exist (already deleted) - both are noDiff
				return {path: clash.path, noDiff: true};
			} else {
				const remoteContent = await this.fit.remoteVault.readFileContent(latestRemoteFileSha);

				// Protected paths (e.g., .obsidian/) should ALWAYS go to _fit/, never written directly
				if (!this.fit.shouldSyncPath(clash.path)) {
					const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent.toBase64());
					return {path: clash.path, noDiff: false, fileOp: fileOp};
				}

				// Unprotected but untracked (e.g., hidden files) - check if file actually exists locally
				// If it doesn't exist, we can write it directly instead of to _fit/
				const stat = existenceMap?.get(clash.path);
				const locallyExists = stat === 'file' || stat === 'folder' || stat === undefined;

				if (locallyExists) {
					// File exists locally (or unknown) - save remote version to _fit/ to avoid overwriting
					const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent.toBase64());
					return {path: clash.path, noDiff: false, fileOp: fileOp};
				} else {
					// File doesn't exist locally - safe to write directly
					fitLogger.log('[FitSync] Untracked file doesn\'t exist locally - writing directly', {
						path: clash.path
					});
					const fileOp = await this.fit.localVault.applyChanges([{
						path: clash.path,
						content: remoteContent
					}], []);
					return {path: clash.path, noDiff: false, fileOp: fileOp[0]};
				}
			}
		}

		const localFileContent = await this.fit.localVault.readFileContent(clash.path);

		if (latestRemoteFileSha) {
			const remoteContent = await this.fit.remoteVault.readFileContent(latestRemoteFileSha);
			// TODO: Should we really need to force to base64 to compare, even if hypothetically both were already plaintext?
			const localBase64 = localFileContent.toBase64();
			const remoteBase64 = remoteContent.toBase64();

			if (removeLineEndingsFromBase64String(remoteBase64) !== removeLineEndingsFromBase64String(localBase64)) {
				const report = this.generateConflictReport(clash.path, localBase64, remoteBase64);
				let fileOp: FileOpRecord;
				if (report.resolutionStrategy === "binary") {
					fileOp = await this.handleBinaryConflict(clash.path, report.remoteContent);
				} else {
					fileOp = await this.handleUTF8Conflict(clash.path, report.localContent, report.remoteContent);
				}
				return {path: clash.path, noDiff: false, fileOp: fileOp};
			}
			return { path: clash.path, noDiff: true };
		} else {
			// assumes remote file is deleted if sha not found in latestRemoteTreeSha.
			return { path: clash.path, noDiff: false };
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
					// File exists - treat as clash
					fitLogger.log('[FitSync] File exists locally but not in cache - saving to _fit/ for safety', {
						path: change.path,
						reason: 'Possible tracking state inconsistency (version migration or bug)'
					});
					resolvedChanges.push({
						path: `_fit/${change.path}`,
						content: change.content
					});
					continue; // Don't risk overwriting local version
				}
				// File doesn't exist locally (stat === 'nonexistent') - safe to write directly
				fitLogger.log('[FitSync] File not in cache but also not on disk - writing directly', {
					path: change.path
				});
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
					// File exists but not tracked - warn user, don't delete
					fitLogger.log('[FitSync] Skipping deletion - file exists but not in cache', {
						path,
						reason: 'Cannot verify safe to delete (possible tracking state inconsistency)'
					});
					continue; // Skip deletion
				}
				// File doesn't exist (stat === 'nonexistent') - deletion already done, no action needed
				fitLogger.log('[FitSync] File already deleted locally', {
					path,
					reason: 'Not in cache and not on disk'
				});
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
		remoteTreeSha: Record<string, string>,
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

		fitLogger.log('[FitSync] Resolving conflicts', {
			clashCount: clashes.length,
			clashes: clashes.map(c => ({ path: c.path, local: c.localStatus, remote: c.remoteStatus }))
		});

		const fileResolutions = await Promise.all(
			clashes.map(async (clash) => {
				try {
					return await this.resolveFileConflict(clash, remoteTreeSha[clash.path], existenceMap);
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
					} else if (res.fileOp && res.fileOp.path.startsWith('_fit/')) {
						filesMovedToFitDueToStatFailure.push(clash.path);
					}
				}
			}
		}

		fitLogger.log('[FitSync] Conflicts resolved', {
			totalResolutions: fileResolutions.length,
			successfulResolutions: fileResolutions.filter(r => r.noDiff).length
		});

		const unresolved = fileResolutions.map((res, i)=> {
			if (!res.noDiff) {
				return clashes[i];
			}
			return null;
		}).filter(Boolean) as Array<ClashStatus>;

		fitLogger.log('[FitSync] Conflict resolution complete', {
			noConflict: fileResolutions.every(res=>res.noDiff),
			unresolvedCount: unresolved.length,
			fileOpsCount: fileResolutions.filter(r => r.fileOp).length
		});

		const ops = fileResolutions.map(r => r.fileOp).filter(Boolean) as FileOpRecord[];

		if (!fileResolutions.every(res=>res.noDiff)) {
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
		clashes: ClashStatus[],
		addToLocalNonClashed: Array<{path: string, content: FileContent}>,
		deleteFromLocalNonClashed: string[]
	): Promise<{existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>, statError: unknown}> {
		// Collect paths that need stat checking from non-clashed remote changes
		const addPathsToCheck = addToLocalNonClashed
			.filter(c => this.fit.shouldSyncPath(c.path))
			.filter(c => !this.fit.localSha.hasOwnProperty(c.path))
			.map(c => c.path);

		const deletePathsToCheck = deleteFromLocalNonClashed
			.filter(p => this.fit.shouldSyncPath(p))
			.filter(p => !this.fit.localSha.hasOwnProperty(p));

		// Also collect paths from clashes (untracked files need stat checking)
		const clashPathsToCheck = clashes
			.filter(c => c.localStatus === 'untracked')
			.map(c => c.path);

		// Combine ALL paths that need stat checking
		const allPathsToCheck = Array.from(new Set([...clashPathsToCheck, ...addPathsToCheck, ...deletePathsToCheck]));

		// Batch stat all paths at once
		let existenceMap: Map<string, 'file' | 'folder' | 'nonexistent'>;
		let statError: unknown = null;
		try {
			const rawStatMap = await this.fit.localVault.statPaths(allPathsToCheck);
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
		syncNotice: FitNotice
	): Promise<SyncExecutionResult> {
		// Phase 1: Detect all clashes between local and remote changes
		const clashes = this.fit.getClashedChanges(localChanges, remoteUpdate.remoteChanges);
		const clashPaths = new Set(clashes.map(c => c.path));

		// Separate clashed remote changes from non-clashed ones
		const remoteChangesToPull = remoteUpdate.remoteChanges.filter(c => !clashPaths.has(c.path));
		const localChangesToPush = localChanges; // Push all, including conflicted

		// Phase 2: Prepare non-clashed remote changes and collect filesystem state
		const deleteFromLocalNonClashed = remoteChangesToPull.filter(c=>c.status==="REMOVED").map(c=>c.path);
		const changesToProcess = remoteChangesToPull.filter(c=>c.status!=="REMOVED").reduce(
			(acc, change) => {
				acc[change.path] = change.currentSha as string;
				return acc;
			}, {} as Record<string, string>);

		const addToLocalNonClashed = await this.getRemoteNonDeletionChangesContent(changesToProcess);

		// Batch stat all paths that need existence checking
		const {existenceMap, statError} = await this.collectFilesystemState(
			clashes,
			addToLocalNonClashed,
			deleteFromLocalNonClashed
		);

		// Phase 3: Resolve all clashes (writes to _fit/ if needed)
		const {
			ops: resolvedConflictOps,
			unresolved: unresolvedConflicts,
			filesMovedToFitDueToStatFailure: filesMovedToFitDueToStatFailureClashes,
			deletionsSkippedDueToStatFailure: deletionsSkippedDueToStatFailureClashes
		} = await this.resolveClashes(clashes, remoteUpdate.remoteTreeSha, existenceMap, syncNotice);

		// Phase 4: Push local changes to remote
		syncNotice.setMessage("Uploading local changes");
		const pushUpdate = {
			localChanges: localChangesToPush,
			parentCommitSha: remoteUpdate.latestRemoteCommitSha
		};
		const pushResult = await this.pushChangedFilesToRemote(pushUpdate);

		let latestRemoteTreeSha: Record<string, string>;
		let latestCommitSha: string;
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

		// Phase 6: Read new local state and persist everything atomically
		const newLocalState = await this.fit.localVault.readFromSource();

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

			// Get local changes
			const {changes: localChanges} = await this.fit.getLocalChanges();
			const filteredLocalChanges = localChanges.filter(c => this.fit.shouldSyncPath(c.path));

			// Check if remote updated
			const {remoteCommitSha, updated: remoteUpdated} = await this.fit.remoteUpdated();

			// Early exit if nothing to sync
			if (filteredLocalChanges.length === 0 && !remoteUpdated) {
				syncNotice.setMessage("Sync successful");
				return { success: true, ops: [], clash: [] };
			}

			// Get remote changes
			const {changes: remoteChanges, state: remoteTreeSha} = await this.fit.getRemoteChanges(remoteCommitSha);

			// Special case: only commit SHA changed, no actual file changes
			if (filteredLocalChanges.length === 0 && remoteChanges.length === 0) {
				await this.saveLocalStoreCallback({ lastFetchedCommitSha: remoteCommitSha });
				syncNotice.setMessage("Sync successful");
				return { success: true, ops: [], clash: [] };
			}

			// Log sync decision for diagnostics
			fitLogger.log('[FitSync] Starting sync', {
				localChangesCount: filteredLocalChanges.length,
				remoteChangesCount: remoteChanges.length,
				remoteUpdated,
				filesPendingRemoteDeletion: filteredLocalChanges.filter(c => c.status === 'deleted').map(c => c.path),
				filesPendingLocalCreation: remoteChanges.filter(c => c.status === 'ADDED').map(c => c.path),
				filesPendingLocalDeletion: remoteChanges.filter(c => c.status === 'REMOVED').map(c => c.path),
				filesPendingRemoteCreation: filteredLocalChanges.filter(c => c.status === 'created').map(c => c.path)
			});

			// Execute sync (handles all clash detection, push, pull, persist)
			const { localOps, remoteOps, conflicts } = await this.performSync(
				filteredLocalChanges,
				{
					remoteChanges,
					remoteTreeSha,
					latestRemoteCommitSha: remoteCommitSha
				},
				syncNotice
			);

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

	// Get changes from remote, pathShaMap is coupled to the Fit plugin design
	private async getRemoteNonDeletionChangesContent(pathShaMap: Record<string, string>): Promise<Array<{path: string, content: FileContent}>> {
		const remoteChanges = Object.entries(pathShaMap).map(async ([path, file_sha]) => {
			const content = await this.fit.remoteVault.readFileContent(file_sha);
			return {path, content};
		});
		return await Promise.all(remoteChanges);
	}

	async pushChangedFilesToRemote(
		localUpdate: LocalUpdate,
	): Promise<{pushedChanges: LocalChange[], lastFetchedRemoteSha: Record<string, string>, lastFetchedCommitSha: string}|null> {
		if (localUpdate.localChanges.length === 0) {
			return null;
		}

		// Prepare files to write and delete by reading content from local vault
		const filesToWrite: Array<{path: string, content: FileContent}> = [];
		const filesToDelete: Array<string> = [];

		for (const change of localUpdate.localChanges) {
			if (change.status === 'deleted') {
				// TODO: CRITICAL SAFEGUARD - Version Migration Safety
				// Before pushing deletion, verify file is physically absent from filesystem.
				// This prevents data loss when filtering rules change between versions.
				//
				// Realistic scenario (DANGEROUS without this check):
				// - v2 implements full hidden file tracking via DataAdapter → localSha has ".gitignore"
				// - v3 reverts feature (performance regression) OR user disables "Sync hidden files" setting
				// - v3/disabled scan can't read hidden files → compareSha reports ".gitignore" as "deleted"
				// - Without check: Plugin deletes from remote → DATA LOSS
				//
				// Solution: Use vault.adapter.exists() to check raw filesystem:
				//   const physicallyExists = await this.fit.localVault.vault.adapter.exists(change.path);
				//   if (physicallyExists) {
				//     fitLogger.log('[FitSync] Skipping deletion - file exists but filtered', {
				//       path: change.path,
				//       reason: 'File present on filesystem but absent from scan (likely filtering rule change)'
				//     });
				//     continue; // Don't delete from remote
				//   }
				filesToDelete.push(change.path);
			} else {
				const content = await this.fit.localVault.readFileContent(change.path);
				filesToWrite.push({ path: change.path, content });
			}
		}

		// Use remoteVault.applyChanges() to handle all GitHub operations
		const fileOps = await this.fit.remoteVault.applyChanges(filesToWrite, filesToDelete);

		// If no operations were performed, return null
		// TODO: Should this be an error since localChanges were detected but nothing pushed?
		if (fileOps.length === 0) {
			return null;
		}

		// Get updated state after push
		const newRemoteCommitSha = await this.fit.remoteVault.getLatestCommitSha();
		const newRemoteState = await this.fit.remoteVault.readFromSource();

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
