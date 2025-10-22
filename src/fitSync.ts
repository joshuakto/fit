import { Fit } from "./fit";
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteChange, RemoteUpdate } from "./fitTypes";
import { RECOGNIZED_BINARY_EXT, extractExtension, removeLineEndingsFromBase64String } from "./utils";
import { FitPull } from "./fitPull";
import { FitPush } from "./fitPush";
import { LocalStores } from "main";
import FitNotice from "./fitNotice";
import { SyncResult, SyncErrors, SyncError } from "./syncResult";
import { fitLogger } from "./logger";
import { VaultError } from "./vault";

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

type PreSyncCheckResult =  {
	status: "inSync"
} | {
	status: Exclude<PreSyncCheckResultType, "inSync">
	remoteUpdate: RemoteUpdate
	localChanges: LocalChange[]
	localTreeSha: Record<string, string>
};

type PreSyncCheckResultType = (
    "inSync" |
    "onlyLocalChanged" |
    "onlyRemoteChanged" |
    "onlyRemoteCommitShaChanged" |
    "localAndRemoteChangesCompatible" |
    "localAndRemoteChangesClashed"
);

/**
 * Sync orchestrator - coordinates all sync operations between local and remote.
 *
 * FitSync is the **main entry point** for synchronization. It:
 * - Analyzes current state to determine what type of sync is needed
 * - Coordinates conflict resolution when local and remote both changed
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
 * - Pre-sync analysis: Determine if changes are compatible or conflicting
 * - Conflict resolution: Decide how to handle clashes, write to _fit/ when needed
 * - Error handling: Catch all errors and categorize them (network, auth, filesystem, etc.)
 * - State updates: Update cached SHAs after successful sync
 *
 * Sync strategies (determined by performPreSyncChecks):
 * - **inSync**: No changes, nothing to do
 * - **onlyLocalChanged**: Push local changes to remote
 * - **onlyRemoteChanged**: Pull remote changes to local
 * - **localAndRemoteChangesCompatible**: Both changed different files, merge them
 * - **localAndRemoteChangesClashed**: Both changed same files, resolve conflicts
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

	async performPreSyncChecks(): Promise<PreSyncCheckResult> {
		// Scan local vault and update its cache
		const {changes: localChanges, state: localState} = await this.fit.getLocalChanges();
		// Filter LOCAL changes based on sync policy (e.g., exclude _fit/, .obsidian/)
		// We don't want to push protected paths to remote
		const filteredLocalChanges = localChanges.filter(change => this.fit.shouldSyncPath(change.path));

		const {remoteCommitSha, updated: remoteUpdated} = await this.fit.remoteUpdated();
		if (filteredLocalChanges.length === 0 && !remoteUpdated) {
			return {status: "inSync"};
		}

		// Scan remote vault (pass commitSha to avoid duplicate API call)
		const {changes: remoteChanges, state: remoteTreeSha} = await this.fit.getRemoteChanges(remoteCommitSha);
		// NOTE: We do NOT filter remote changes here by shouldSyncPath
		// Protected paths from remote (like .obsidian/, _fit/) will be handled in
		// prepareChangesToExecute() and saved to _fit/ for user safety and transparency

		let clashes: ClashStatus[] = [];
		let status: PreSyncCheckResultType;
		if (filteredLocalChanges.length > 0 && !remoteUpdated) {
			status = "onlyLocalChanged";
		} else if (remoteUpdated && filteredLocalChanges.length === 0 && remoteChanges.length === 0) {
			status = "onlyRemoteCommitShaChanged";
		} else if (filteredLocalChanges.length === 0 && remoteUpdated) {
			// Check for clashes even when there are no local changes
			// (protected/hidden files from remote are always treated as clashes)
			clashes = this.fit.getClashedChanges(filteredLocalChanges, remoteChanges);
			if (clashes.length === 0) {
				status = "onlyRemoteChanged";
			} else {
				status = "localAndRemoteChangesClashed";
			}
		} else {
			clashes = this.fit.getClashedChanges(filteredLocalChanges, remoteChanges);
			if (clashes.length === 0) {
				status = "localAndRemoteChangesCompatible";
			} else {
				status =  "localAndRemoteChangesClashed";
			}
		}

		// Log sync decision to diagnose incorrect create/delete behaviors
		fitLogger.log('[FitSync] Pre-sync check complete', {
			status,
			localChangesCount: localChanges.length,
			remoteChangesCount: remoteChanges.length,
			clashesCount: clashes.length,
			remoteUpdated,
			// Critical: Track files that will be pushed/pulled
			filesPendingRemoteDeletion: localChanges.filter(c => c.status === 'deleted').map(c => c.path),
			filesPendingLocalCreation: remoteChanges.filter(c => c.status === 'ADDED').map(c => c.path),
			filesPendingLocalDeletion: remoteChanges.filter(c => c.status === 'REMOVED').map(c => c.path),
			filesPendingRemoteCreation: localChanges.filter(c => c.status === 'created').map(c => c.path)
		});

		return {
			status,
			remoteUpdate: {
				remoteChanges: remoteChanges,
				remoteTreeSha,
				latestRemoteCommitSha: remoteCommitSha,
				clashedFiles: clashes
			},
			localChanges: filteredLocalChanges,
			localTreeSha: localState
		};
	}

	generateConflictReport(path: string, localContent: string, remoteContent: string): ConflictReport {
		const detectedExtension = extractExtension(path);
		if (detectedExtension && RECOGNIZED_BINARY_EXT.includes(detectedExtension)) {
			return {
				path,
				resolutionStrategy: "binary",
				remoteContent
			};
		}
		// assume file encoding is utf8 if extension is not known
		return {
			path,
			resolutionStrategy: "utf-8",
			localContent,
			remoteContent,
		};
	}

	async handleBinaryConflict(path: string, remoteContent: string): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteContent);
	}

	async handleUTF8Conflict(path: string, localContent: string, remoteConent: string): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteConent);
	}

	async handleLocalDeletionConflict(path: string, remoteContent: string): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit";
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`;
		return await this.fit.localVault.writeFile(conflictResolutionPath, remoteContent);
	}

	async resolveFileConflict(clash: ClashStatus, latestRemoteFileSha: string): Promise<ConflictResolutionResult> {
		if (clash.localStatus === "deleted" && clash.remoteStatus === "REMOVED") {
			return {path: clash.path, noDiff: true};
		} else if (clash.localStatus === "deleted") {
			const remoteContent = await this.fit.remoteVault.readFileContent(latestRemoteFileSha);
			const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent);
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
				const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent);
				return {path: clash.path, noDiff: false, fileOp: fileOp};
			}
		}

		const localFileContent = await this.fit.localVault.readFileContent(clash.path);

		if (latestRemoteFileSha) {
			const remoteContent = await this.fit.remoteVault.readFileContent(latestRemoteFileSha);
			if (removeLineEndingsFromBase64String(remoteContent) !== removeLineEndingsFromBase64String(localFileContent)) {
				const report = this.generateConflictReport(clash.path, localFileContent, remoteContent);
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

	async syncCompatibleChanges(
		localUpdate: LocalUpdate,
		remoteUpdate: RemoteUpdate,
		syncNotice: FitNotice): Promise<{localOps: LocalChange[], remoteOps: FileOpRecord[]}> {
		const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
			remoteUpdate.remoteChanges);
		syncNotice.setMessage("Uploading local changes");
		// Push local changes to remote
		const pushResult = await this.fitPush.pushChangedFilesToRemote(localUpdate);
		let latestRemoteTreeSha: Record<string, string>;
		let latestCommitSha: string;
		let pushedChanges: Array<LocalChange>;
		if (pushResult) {
			latestRemoteTreeSha = pushResult.lastFetchedRemoteSha;
			latestCommitSha = pushResult.lastFetchedCommitSha;
			pushedChanges = pushResult.pushedChanges;
		} else {
			// No changes were pushed
			// TODO: Abort the sync if there were local changes detected but nothing pushed?
			// Otherwise we may record them as synced below and incorrectly overwrite them from remote later.
			latestRemoteTreeSha = remoteUpdate.remoteTreeSha;
			latestCommitSha = remoteUpdate.latestRemoteCommitSha;
			pushedChanges = [];
		}

		syncNotice.setMessage("Writing remote changes to local");
		const localFileOpsRecord = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

		// Update local vault state after applying changes
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
		syncNotice.setMessage("Sync successful");
		return {localOps: localFileOpsRecord, remoteOps: pushedChanges};
	}


	async syncWithConflicts(
		localChanges: LocalChange[],
		remoteUpdate: RemoteUpdate,
		syncNotice: FitNotice) : Promise<{unresolvedFiles: ClashStatus[], localOps: LocalChange[], remoteOps: LocalChange[]} | null> {
		const {latestRemoteCommitSha, clashedFiles, remoteTreeSha: latestRemoteTreeSha} = remoteUpdate;
		let noConflict: boolean, unresolvedFiles: ClashStatus[], fileOpsRecord: FileOpRecord[];
		({noConflict, unresolvedFiles, fileOpsRecord} = await this.resolveConflicts(clashedFiles, latestRemoteTreeSha));
		let localChangesToPush: Array<LocalChange>;
		let remoteChangesToWrite: Array<RemoteChange>;
		if (noConflict) {
			// no conflict detected among clashed files, just pull changes only made on remote and push changes only made on local
			remoteChangesToWrite = remoteUpdate.remoteChanges.filter(c => !localChanges.some(l => l.path === c.path));
			localChangesToPush = localChanges.filter(c => !remoteUpdate.remoteChanges.some(r => r.path === c.path));

		} else {
			syncNotice.setMessage(`Change conflicts detected`);
			// do not modify unresolved files locally
			remoteChangesToWrite = remoteUpdate.remoteChanges.filter(c => !unresolvedFiles.some(l => l.path === c.path));
			// push change even if they are in unresolved files, so remote has a record of them,
			// so user can resolve later by modifying local and push again
			localChangesToPush = localChanges;
		}
		const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(remoteChangesToWrite);
		const syncLocalUpdate = {
			localChanges: localChangesToPush,
			parentCommitSha: latestRemoteCommitSha
		};
		const pushResult = await this.fitPush.pushChangedFilesToRemote(syncLocalUpdate);
		let pushedChanges: LocalChange[];
		let lastFetchedCommitSha: string;
		let lastFetchedRemoteSha: Record<string, string>;
		if (pushResult) {
			pushedChanges = pushResult.pushedChanges;
			lastFetchedCommitSha = pushResult.lastFetchedCommitSha;
			lastFetchedRemoteSha = pushResult.lastFetchedRemoteSha;
		} else {
			// did not push any changes
			pushedChanges = [];
			lastFetchedCommitSha = remoteUpdate.latestRemoteCommitSha;
			lastFetchedRemoteSha = remoteUpdate.remoteTreeSha;
		}

		let localFileOpsRecord: LocalChange[];
		localFileOpsRecord = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

		// Update local vault state after applying changes
		const newLocalState = await this.fit.localVault.readFromSource();

		logCacheUpdate(
			'conflict sync',
			this.fit.localSha || {},
			newLocalState,
			this.fit.lastFetchedRemoteSha || {},
			lastFetchedRemoteSha,
			this.fit.lastFetchedCommitSha,
			lastFetchedCommitSha,
			{ unresolvedConflicts: unresolvedFiles.length, localOpsApplied: localFileOpsRecord.length, remoteOpsPushed: pushedChanges.length }
		);

		await this.saveLocalStoreCallback({
			lastFetchedRemoteSha, // Unfiltered - must track ALL remote files to detect changes
			lastFetchedCommitSha,
			localSha: this.fit.filterSyncedState(newLocalState)
		});
		const ops = localFileOpsRecord.concat(fileOpsRecord);
		if (unresolvedFiles.length === 0) {
			syncNotice.setMessage(`Sync successful`);
		} else if (unresolvedFiles.some(f => f.remoteStatus !== "REMOVED")) {
			// let user knows remote file changes have been written to _fit if non-deletion change on remote clashed with local changes
			syncNotice.setMessage(`Synced with remote, unresolved conflicts written to _fit`);
		} else {
			syncNotice.setMessage(`Synced with remote, ignored remote deletion of locally changed files`);
		}
		return {unresolvedFiles, localOps: ops, remoteOps: pushedChanges};
	}

	async sync(syncNotice: FitNotice): Promise<SyncResult> {
		try {
			syncNotice.setMessage("Performing pre sync checks.");
			const preSyncCheckResult = await this.performPreSyncChecks();

			// convert to switch statement later on for better maintainability
			if (preSyncCheckResult.status === "inSync") {
				syncNotice.setMessage("Sync successful");
				return { success: true, ops: [], clash: [] };
			}

			if (preSyncCheckResult.status === "onlyRemoteCommitShaChanged") {
				const { latestRemoteCommitSha } = preSyncCheckResult.remoteUpdate;
				await this.saveLocalStoreCallback({ lastFetchedCommitSha: latestRemoteCommitSha });
				syncNotice.setMessage("Sync successful");
				return { success: true, ops: [], clash: [] };
			}

			const remoteUpdate = preSyncCheckResult.remoteUpdate;
			if (preSyncCheckResult.status === "onlyRemoteChanged") {
				const fileOpsRecord = await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback);
				syncNotice.setMessage("Sync successful");
				return { success: true, ops: [{ heading: "Local file updates:", ops: fileOpsRecord }], clash: [] };
			}

			const {localChanges, localTreeSha} = preSyncCheckResult;
			const localUpdate = {
				localChanges,
				parentCommitSha: remoteUpdate.latestRemoteCommitSha
			};
			if (preSyncCheckResult.status === "onlyLocalChanged") {
				syncNotice.setMessage("Uploading local changes");
				const pushResult = await this.fitPush.pushChangedFilesToRemote(localUpdate);
				syncNotice.setMessage("Sync successful");
				if (pushResult) {
					logCacheUpdate(
						'push',
						this.fit.localSha || {},
						localTreeSha,
						this.fit.lastFetchedRemoteSha || {},
						pushResult.lastFetchedRemoteSha,
						this.fit.lastFetchedCommitSha,
						pushResult.lastFetchedCommitSha,
						{ pushedChanges: pushResult.pushedChanges.length }
					);

					await this.saveLocalStoreCallback({
						localSha: this.fit.filterSyncedState(localTreeSha),
						lastFetchedRemoteSha: pushResult.lastFetchedRemoteSha, // Unfiltered - must track ALL remote files to detect changes
						lastFetchedCommitSha: pushResult.lastFetchedCommitSha
					});
					return { success: true, ops: [{ heading: "Local file updates:", ops: pushResult.pushedChanges }], clash: [] };
				}
				return { success: false, error: SyncErrors.unknown("Failed to push local changes") };
			}

			// do both pull and push (orders of execution different from pullRemoteToLocal and
			// pushChangedFilesToRemote to make this more transaction like, i.e. maintain original
			// state if the transaction failed) If you have ideas on how to make this more transaction-like,
			// please open an issue on the fit repo
			if (preSyncCheckResult.status === "localAndRemoteChangesCompatible") {
				const {localOps, remoteOps} = await this.syncCompatibleChanges(
					localUpdate, remoteUpdate, syncNotice);
				return {
					success: true,
					ops: [
						{heading: "Local file updates:", ops: localOps},
						{heading: "Remote file updates:", ops: remoteOps},
					],
					clash: []
				};
			}

			if (preSyncCheckResult.status === "localAndRemoteChangesClashed") {
				const conflictResolutionResult = await this.syncWithConflicts(
					localUpdate.localChanges, remoteUpdate, syncNotice);
				if (conflictResolutionResult) {
					const {unresolvedFiles, localOps, remoteOps} = conflictResolutionResult;
					return {
						success: true,
						ops: [
							{heading: "Local file updates:", ops: localOps},
							{heading: "Remote file updates:", ops: remoteOps},
						],
						clash: unresolvedFiles
					};
				}
			}

			// Fallback case - shouldn't reach here
			return { success: false, error: SyncErrors.unknown("Unknown sync status") };

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
