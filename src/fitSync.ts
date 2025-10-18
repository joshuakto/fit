import { Fit } from "./fit";
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteChange, RemoteUpdate } from "./fitTypes";
import { extractExtension, removeLineEndingsFromBase64String } from "./utils";
import { FitPull } from "./fitPull";
import { FitPush } from "./fitPush";
import { LocalStores } from "main";
import FitNotice from "./fitNotice";
import { SyncResult, SyncErrors, SyncError } from "./syncResult";
import { fitLogger } from "./logger";
import { VaultError } from "./vault";
import { Base64Content, isBinaryExtension } from "./contentEncoding";

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
 * - Delegates to FitPull for remote→local operations
 * - Delegates to FitPush for local→remote operations
 * - Categorizes errors into user-friendly messages
 *
 * Architecture:
 * - **Role**: High-level orchestrator and decision maker
 * - **Used by**: FitPlugin (main.ts) - the Obsidian plugin entry point
 * - **Uses**: Fit (data access), FitPull (pull ops), FitPush (push ops)
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
 * @see FitPull - Handles pull (remote→local) operations
 * @see FitPush - Handles push (local→remote) operations
 */
export class FitSync implements IFitSync {
	fit: Fit;
	fitPull: FitPull;
	fitPush: FitPush;
	saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>;


	constructor(fit: Fit, saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>) {
		this.fit = fit;
		this.fitPull = new FitPull(fit);
		this.fitPush = new FitPush(fit);
		this.saveLocalStoreCallback = saveLocalStoreCallback;
	}

	generateConflictReport(path: string, localContent: Base64Content, remoteContent: Base64Content): ConflictReport {
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

	async handleBinaryConflict(path: string, remoteContent: Base64Content): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteContent);
	}

	async handleUTF8Conflict(path: string, localContent: Base64Content, remoteConent: Base64Content): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteConent);
	}

	async handleLocalDeletionConflict(path: string, remoteContent: Base64Content): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteContent);
	}

	async resolveFileConflict(clash: ClashStatus, latestRemoteFileSha: string): Promise<ConflictResolutionResult> {
		if (clash.localStatus === "deleted" && clash.remoteStatus === "REMOVED") {
			return {path: clash.path, noDiff: true};
		} else if (clash.localStatus === "deleted") {
			const remoteContent = await this.fit.remoteVault.readFileContent(latestRemoteFileSha);
			const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent.toBase64());
			return {path: clash.path, noDiff: false, fileOp: fileOp};
		} else if (clash.localStatus === "untracked") {
			// File is protected path or hidden - can't verify local state
			if (clash.remoteStatus === "REMOVED") {
				// Remote deleted, local untracked - can't verify if safe to delete locally
				// Do nothing (don't delete local file, don't save to _fit/)
				return {path: clash.path, noDiff: true};
			} else {
				// Remote added/modified, local untracked - save remote version to _fit/
				const remoteContent = await this.fit.remoteVault.readFileContent(latestRemoteFileSha);
				const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent.toBase64());
				return {path: clash.path, noDiff: false, fileOp: fileOp};
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

	async resolveConflicts(
		clashedFiles: Array<ClashStatus>, latestRemoteTreeSha: Record<string, string>)
		: Promise<{noConflict: boolean, unresolvedFiles: ClashStatus[], fileOpsRecord: FileOpRecord[]}> {
		fitLogger.log('[FitSync] Resolving conflicts', {
			clashCount: clashedFiles.length,
			clashes: clashedFiles.map(c => ({ path: c.path, local: c.localStatus, remote: c.remoteStatus }))
		});

		const fileResolutions = await Promise.all(
			clashedFiles.map(async (clash) => {
				try {
					return await this.resolveFileConflict(clash, latestRemoteTreeSha[clash.path]);
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

		fitLogger.log('[FitSync] Conflicts resolved', {
			totalResolutions: fileResolutions.length,
			successfulResolutions: fileResolutions.filter(r => r.noDiff).length
		});

		const unresolvedFiles = fileResolutions.map((res, i)=> {
			if (!res.noDiff) {
				return clashedFiles[i];
			}
			return null;
		}).filter(Boolean) as Array<ClashStatus>;

		fitLogger.log('[FitSync] Conflict resolution complete', {
			noConflict: fileResolutions.every(res=>res.noDiff),
			unresolvedCount: unresolvedFiles.length,
			fileOpsCount: fileResolutions.filter(r => r.fileOp).length
		});

		return {
			noConflict: fileResolutions.every(res=>res.noDiff),
			unresolvedFiles,
			fileOpsRecord: fileResolutions.map(r => r.fileOp).filter(Boolean) as FileOpRecord[]
		};
	}

	/**
	 * Plan for what changes to sync, separating changes that can be applied
	 * from those that are in conflict.
	 */
	private prepareSyncPlan(
		localChanges: LocalChange[],
		remoteChanges: RemoteChange[],
		knownConflicts: ClashStatus[]
	): { localChangesToPush: LocalChange[], remoteChangesToPull: RemoteChange[] } {
		const conflictPaths = new Set(knownConflicts.map(c => c.path));

		if (knownConflicts.length === 0) {
			// No conflicts - can sync all changes
			return {
				localChangesToPush: localChanges,
				remoteChangesToPull: remoteChanges
			};
		}

		// Has conflicts - filter out conflicted files from remote pull
		// but still push local changes (so remote has record for later resolution)
		const remoteChangesToPull = remoteChanges.filter(c => !conflictPaths.has(c.path));
		const localChangesToPush = localChanges; // Push all, including conflicted

		return { localChangesToPush, remoteChangesToPull };
	}

	/**
	 * Execute a sync plan: push local changes, pull remote changes, and persist state.
	 * This is the unified execution path for both compatible and conflicted syncs.
	 *
	 * The operation is atomic: if any step fails, no state is persisted.
	 *
	 * @returns The operations that were applied and any conflicts discovered during execution
	 */
	private async executeSyncPlan(
		plan: { localChangesToPush: LocalChange[], remoteChangesToPull: RemoteChange[] },
		localUpdate: LocalUpdate,
		remoteUpdate: RemoteUpdate,
		syncNotice: FitNotice
	): Promise<SyncExecutionResult> {
		// Phase 1: Push local changes to remote
		syncNotice.setMessage("Uploading local changes");
		const pushUpdate = {
			localChanges: plan.localChangesToPush,
			parentCommitSha: localUpdate.parentCommitSha
		};
		const pushResult = await this.fitPush.pushChangedFilesToRemote(pushUpdate);

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

		// Phase 2: Pull remote changes to local
		syncNotice.setMessage("Writing remote changes to local");
		const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
			plan.remoteChangesToPull);

		// Apply changes (prepareChangesToExecute already filtered to save conflicts to _fit/)
		const localFileOpsRecord = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

		// Phase 3: Read new local state and persist everything atomically
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
			localOps: localFileOpsRecord,
			remoteOps: pushedChanges,
			conflicts: [] // Conflicts are saved to _fit/ during prepareChangesToExecute
		};
	}

	/**
	 * Execute a sync with local and remote changes, handling any conflicts.
	 *
	 * This is the unified sync execution path that works regardless of whether
	 * conflicts are known upfront or discovered during execution.
	 *
	 * @param localChanges All local changes detected
	 * @param remoteUpdate All remote changes and state
	 * @param upfrontConflicts Conflicts detected during pre-sync checks (may be empty)
	 * @param syncNotice UI notification to update with progress
	 * @returns Complete sync result with all operations and conflicts
	 */
	private async executeSync(
		localChanges: LocalChange[],
		remoteUpdate: RemoteUpdate,
		upfrontConflicts: ClashStatus[],
		syncNotice: FitNotice
	): Promise<SyncExecutionResult> {
		// Step 1: Resolve any upfront conflicts (writes to _fit/ if needed)
		let resolvedConflictOps: FileOpRecord[] = [];
		let unresolvedUpfrontConflicts: ClashStatus[] = [];

		if (upfrontConflicts.length > 0) {
			const {noConflict, unresolvedFiles, fileOpsRecord} = await this.resolveConflicts(
				upfrontConflicts,
				remoteUpdate.remoteTreeSha
			);
			resolvedConflictOps = fileOpsRecord;
			unresolvedUpfrontConflicts = unresolvedFiles;

			if (!noConflict) {
				syncNotice.setMessage(`Change conflicts detected`);
			}
		}

		// Step 2: Prepare sync plan (filter out unresolved conflicts)
		const plan = this.prepareSyncPlan(
			localChanges,
			remoteUpdate.remoteChanges,
			unresolvedUpfrontConflicts
		);

		// Step 3: Execute the plan (push, pull, persist)
		const localUpdate = {
			localChanges: plan.localChangesToPush,
			parentCommitSha: remoteUpdate.latestRemoteCommitSha
		};

		const { localOps, remoteOps, conflicts: newConflicts } = await this.executeSyncPlan(
			plan,
			localUpdate,
			remoteUpdate,
			syncNotice
		);

		// Step 4: Combine all conflicts and operations
		const allConflicts = [...unresolvedUpfrontConflicts, ...newConflicts];
		const allLocalOps = localOps.concat(resolvedConflictOps);

		// Step 5: Set appropriate success message
		if (allConflicts.length === 0) {
			syncNotice.setMessage(`Sync successful`);
		} else if (allConflicts.some(f => f.remoteStatus !== "REMOVED")) {
			syncNotice.setMessage(`Synced with remote, unresolved conflicts written to _fit`);
		} else {
			syncNotice.setMessage(`Synced with remote, ignored remote deletion of locally changed files`);
		}

		return {
			localOps: allLocalOps,
			remoteOps,
			conflicts: allConflicts
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

			// Detect conflicts upfront
			const upfrontConflicts = this.fit.getClashedChanges(filteredLocalChanges, remoteChanges);

			// Log sync decision for diagnostics
			fitLogger.log('[FitSync] Starting sync', {
				localChangesCount: filteredLocalChanges.length,
				remoteChangesCount: remoteChanges.length,
				upfrontConflictsCount: upfrontConflicts.length,
				remoteUpdated,
				filesPendingRemoteDeletion: filteredLocalChanges.filter(c => c.status === 'deleted').map(c => c.path),
				filesPendingLocalCreation: remoteChanges.filter(c => c.status === 'ADDED').map(c => c.path),
				filesPendingLocalDeletion: remoteChanges.filter(c => c.status === 'REMOVED').map(c => c.path),
				filesPendingRemoteCreation: filteredLocalChanges.filter(c => c.status === 'created').map(c => c.path)
			});

			// Execute sync (handles push, pull, and conflicts all in one unified path)
			const {localOps, remoteOps, conflicts} = await this.executeSync(
				filteredLocalChanges,
				{
					remoteChanges,
					remoteTreeSha,
					latestRemoteCommitSha: remoteCommitSha,
					clashedFiles: upfrontConflicts
				},
				upfrontConflicts,
				syncNotice
			);

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
