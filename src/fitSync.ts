import { Fit } from "./fit";
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteChange, RemoteUpdate } from "./fitTypes";
import { RECOGNIZED_BINARY_EXT, extractExtension, removeLineEndingsFromBase64String } from "./utils";
import { FitPull } from "./fitPull";
import { FitPush } from "./fitPush";
import { LocalStores } from "main";
import FitNotice from "./fitNotice";
import { SyncResult, SyncErrors } from "./syncResult";
import { OctokitHttpError } from "./fit";
import { RemoteNotFoundError } from "./vault";

type FilesystemError = Error & { isFilesystemError: true };

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

		const {remoteCommitSha, updated: remoteUpdated} = await this.fit.remoteUpdated();
		if (localChanges.length === 0 && !remoteUpdated) {
			return {status: "inSync"};
		}

		// Scan remote vault and update its cache
		const {changes: remoteChanges, state: remoteTreeSha} = await this.fit.getRemoteChanges();

		let clashes: ClashStatus[] = [];
		let status: PreSyncCheckResultType;
		if (localChanges.length > 0 && !remoteUpdated) {
			status = "onlyLocalChanged";
		} else if (remoteUpdated && localChanges.length === 0 && remoteChanges.length === 0) {
			status = "onlyRemoteCommitShaChanged";
		} else if (localChanges.length === 0 && remoteUpdated) {
			status = "onlyRemoteChanged";
		} else {
			clashes = this.fit.getClashedChanges(localChanges, remoteChanges);
			if (clashes.length === 0) {
				status = "localAndRemoteChangesCompatible";
			} else {
				status =  "localAndRemoteChangesClashed";
			}
		}
		return {
			status,
			remoteUpdate: {
				remoteChanges,
				remoteTreeSha,
				latestRemoteCommitSha: remoteCommitSha,
				clashedFiles: clashes
			},
			localChanges,
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
		const fileResolutions = await Promise.all(
			clashedFiles.map(clash=>{return this.resolveFileConflict(clash, latestRemoteTreeSha[clash.path]);}));
		const unresolvedFiles = fileResolutions.map((res, i)=> {
			if (!res.noDiff) {
				return clashedFiles[i];
			}
			return null;
		}).filter(Boolean) as Array<ClashStatus>;
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
			latestRemoteTreeSha = remoteUpdate.remoteTreeSha;
			latestCommitSha = remoteUpdate.latestRemoteCommitSha;
			pushedChanges = [];
		}

		syncNotice.setMessage("Writing remote changes to local");
		const localFileOpsRecord = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

		// Update local vault state after applying changes
		const newLocalState = await this.fit.localVault.readFromSource();

		await this.saveLocalStoreCallback({
			lastFetchedRemoteSha: latestRemoteTreeSha,
			lastFetchedCommitSha: latestCommitSha,
			localSha: newLocalState
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
		try {
			({noConflict, unresolvedFiles, fileOpsRecord} = await this.resolveConflicts(clashedFiles, latestRemoteTreeSha));
		} catch (error) {
			// Mark filesystem errors for proper classification in outer catch block
			const fsError = error instanceof Error ? error : new Error(String(error));
			(fsError as FilesystemError).isFilesystemError = true;
			throw fsError;
		}
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
		try {
			localFileOpsRecord = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

			// Update local vault state after applying changes
			const newLocalState = await this.fit.localVault.readFromSource();

			await this.saveLocalStoreCallback({
				lastFetchedRemoteSha,
				lastFetchedCommitSha,
				localSha: newLocalState
			});
		} catch (error) {
			// Mark filesystem errors for proper classification in outer catch block
			const fsError = error instanceof Error ? error : new Error(String(error));
			(fsError as FilesystemError).isFilesystemError = true;
			throw fsError;
		}
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
				try {
					const fileOpsRecord = await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback);
					syncNotice.setMessage("Sync successful");
					return { success: true, ops: [{ heading: "Local file updates:", ops: fileOpsRecord }], clash: [] };
				} catch (error) {
					// Mark filesystem errors for proper classification in outer catch block
					const fsError = error instanceof Error ? error : new Error(String(error));
					(fsError as FilesystemError).isFilesystemError = true;
					throw fsError;
				}
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
					// Vault caches already updated in pre-sync checks, just save to persistent storage
					await this.saveLocalStoreCallback({
						localSha: localTreeSha,
						lastFetchedRemoteSha: pushResult.lastFetchedRemoteSha,
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
			// Ensures good meaningful detailMessage according to the guidelines documented on SyncError.detailMessage.

			// Check if error came from filesystem operations
			if ((error as FilesystemError)?.isFilesystemError) {
				const message = error instanceof Error
					? error.message
					: (error && typeof error === 'object' && error.message)
						? String(error.message)
						: `File operation failed: ${String(error)}`; // May result in '[object Object]' but it's the best we can do
				return { success: false, error: SyncErrors.filesystem(message, { originalError: error }) };
			}

			if (error instanceof OctokitHttpError) {
				// Detect network connectivity issues - either no status or fake 500 without response
				if (error.status === null || (error.status === 500 && (error as unknown as { response?: unknown }).response === undefined)) {
					return { success: false, error: SyncErrors.network("Couldn't reach GitHub API", { source: error.source, originalError: error }) };
				}

				// GitHub API authentication/authorization errors
				if (error.status === 401) {
					return { success: false, error: SyncErrors.remoteAccess('Authentication failed (bad token?)', { source: error.source, originalError: error }) };
				}

				// Rate limiting is now handled automatically by @octokit/plugin-retry
				if (error.status === 403) {
					return { success: false, error: SyncErrors.remoteAccess('Access denied (token missing permissions?)', { source: error.source, originalError: error }) };
				}

				// All other GitHub API errors (rate limiting, server errors, etc.)
				return { success: false, error: SyncErrors.apiError('GitHub API error', { source: error.source, originalError: error }) };
			}

			// Catch RemoteNotFoundError from RemoteGitHubVault (404 errors)
			if (error instanceof RemoteNotFoundError) {
				// The error message from RemoteGitHubVault is already user-friendly
				return { success: false, error: SyncErrors.remoteNotFound(error.message, { originalError: error }) };
			}

			// All other errors - unknown type
			const errorMessage = error instanceof Error
				? String(error) // Gets "ErrorType: message" which includes both type and message
				: (error && typeof error === 'object' && error.message)
					? String(error.message)
					: `Generic error: ${String(error)}`; // May result in '[object Object]' but it's the best we can do
			return { success: false, error: SyncErrors.unknown(errorMessage, { originalError: error }) };
		}
	}
}
