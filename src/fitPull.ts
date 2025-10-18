import { Fit } from "./fit";
import { LocalStores } from "main";
import { FileOpRecord, LocalChange, RemoteChange, RemoteUpdate } from "./fitTypes";
import { fitLogger } from "./logger";

type PrePullCheckResultType = (
    "localCopyUpToDate" |
    "localChangesClashWithRemoteChanges" |
    "remoteChangesCanBeMerged" |
    "noRemoteChangesDetected"
);

type PrePullCheckResult = (
    { status: "localCopyUpToDate", remoteUpdate: null } |
    { status: Exclude<PrePullCheckResultType, "localCopyUpToDate">, remoteUpdate: RemoteUpdate }
);

/**
 * Handles pull operations - syncing changes from remote GitHub to local vault.
 *
 * Encapsulates the logic for:
 * - Fetching remote file content from GitHub (via Fit.getBlob)
 * - Writing remote changes to local vault (via Fit.localVault.applyChanges)
 * - Updating cached state after successful pull
 *
 * Architecture:
 * - **Role**: Directional sync coordinator (remote→local only)
 * - **Used by**: FitSync (orchestrator)
 * - **Uses**: Fit (for GitHub API and local vault access)
 *
 * Key methods:
 * - pullRemoteToLocal(): Complete pull operation with state updates
 * - prepareChangesToExecute(): Separates adds/modifications from deletions
 * - getRemoteNonDeletionChangesContent(): Fetches file content from GitHub
 *
 * @see FitSync - The orchestrator that decides when to pull
 * @see FitPush - The counterpart for push operations
 * @see Fit - Provides GitHub API access and local vault operations
 */
export class FitPull {
	fit: Fit;


	constructor(fit: Fit) {
		this.fit = fit;
	}

	async performPrePullChecks(localChanges?: LocalChange[]): Promise<PrePullCheckResult> {
		const {remoteCommitSha, updated} = await this.fit.remoteUpdated();
		if (!updated) {
			return {status: "localCopyUpToDate", remoteUpdate: null};
		}
		if (!localChanges) {
			// Scan vault and compare against latest known state
			localChanges = (await this.fit.getLocalChanges()).changes;
		}

		// Use the remoteCommitSha we already fetched to avoid duplicate API call
		const { changes: remoteChanges, state: remoteState } = await this.fit.getRemoteChanges(remoteCommitSha);

		const clashedFiles = this.fit.getClashedChanges(localChanges, remoteChanges);
		// TODO handle clashes without completely blocking pull
		const prePullCheckStatus = (
			(remoteChanges.length > 0) ? (
				(clashedFiles.length > 0) ? "localChangesClashWithRemoteChanges" : "remoteChangesCanBeMerged"):
				"noRemoteChangesDetected");

		return {
			status: prePullCheckStatus,
			remoteUpdate: {
				remoteChanges, remoteTreeSha: remoteState, latestRemoteCommitSha: remoteCommitSha, clashedFiles
			}
		};
	}

	// Get changes from remote, pathShaMap is coupled to the Fit plugin design
	async getRemoteNonDeletionChangesContent(pathShaMap: Record<string, string>) {
		const remoteChanges = Object.entries(pathShaMap).map(async ([path, file_sha]) => {
			const content = await this.fit.remoteVault.readFileContent(file_sha);
			return {path, content};
		});
		return await Promise.all(remoteChanges);
	}

	async prepareChangesToExecute(remoteChanges: RemoteChange[]) {
		const deleteFromLocal = remoteChanges.filter(c=>c.status==="REMOVED").map(c=>c.path);
		const changesToProcess = remoteChanges.filter(c=>c.status!=="REMOVED").reduce(
			(acc, change) => {
				acc[change.path] = change.currentSha as string;
				return acc;
			}, {} as Record<string, string>);

		const addToLocal = await this.getRemoteNonDeletionChangesContent(changesToProcess);

		// Check for files that should be saved to _fit/ instead of directly applied
		const resolvedChanges: Array<{path: string, content: string}> = [];
		for (const change of addToLocal) {
			// SAFETY: Save protected paths to _fit/ (e.g., .obsidian/, _fit/)
			// These paths should never be written directly to the vault to avoid:
			// - Overwriting critical Obsidian settings/plugins (.obsidian/)
			// - Conflicting with our conflict resolution area (_fit/)
			// - User confusion from inconsistent behavior (_fit/_fit/ for remote _fit/ files)
			if (!this.fit.shouldSyncPath(change.path)) {
				fitLogger.log('[FitPull] Protected path - saving to _fit/ for safety', {
					path: change.path,
					reason: 'path excluded by shouldSyncPath (e.g., .obsidian/, _fit/)'
				});
				resolvedChanges.push({
					path: `_fit/${change.path}`,
					content: change.content
				});
				continue; // Don't write to protected path
			}

			// SAFETY: Save untracked files to _fit/ (e.g., hidden files)
			// We can't trust that we've detected all local changes because:
			// 1. The file isn't in localSha (not tracked by LocalVault.shouldTrackState)
			// 2. Even fileExists() check may not be reliable for all hidden file types
			// 3. Conservative approach: assume potential conflict, let user verify
			//
			// TODO: Improve this by:
			// - Actually reading and comparing content when file is detected
			// - Auto-applying if content matches exactly
			// - Only saving to _fit/ if content differs or can't be read
			if (!this.fit.localVault.shouldTrackState(change.path)) {
				fitLogger.log('[FitPull] Untracked file - saving to _fit/ for safety', {
					path: change.path,
					reason: 'file not tracked in localSha, cannot verify safety'
				});
				resolvedChanges.push({
					path: `_fit/${change.path}`,
					content: change.content
				});
				continue; // Don't risk overwriting local version
			}

			// Normal file or no conflict - add as-is
			resolvedChanges.push(change);
		}

		// SAFETY: Never delete protected or untracked files from local
		const safeDeleteFromLocal = deleteFromLocal.filter(path => {
			// Skip deletion of protected paths (shouldn't exist locally, but be safe)
			if (!this.fit.shouldSyncPath(path)) {
				fitLogger.log('[FitPull] Skipping deletion of protected path', {
					path,
					reason: 'path excluded by shouldSyncPath (e.g., .obsidian/, _fit/)'
				});
				return false; // Skip deletion
			}

			// Skip deletion of untracked files
			// We cannot verify if the file exists locally or has local changes because
			// it's not in localSha. Attempting to delete could cause data loss.
			if (!this.fit.localVault.shouldTrackState(path)) {
				fitLogger.log('[FitPull] Skipping deletion of untracked file', {
					path,
					reason: 'file not tracked in localSha, cannot verify safe to delete'
				});
				return false; // Skip deletion
			}

			return true; // Safe to delete
		});

		return {addToLocal: resolvedChanges, deleteFromLocal: safeDeleteFromLocal};
	}

	async pullRemoteToLocal(
		remoteUpdate: RemoteUpdate,
		saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>): Promise<FileOpRecord[]> {
		const {remoteChanges, remoteTreeSha, latestRemoteCommitSha} = remoteUpdate;
		const {addToLocal, deleteFromLocal} = await this.prepareChangesToExecute(remoteChanges);

		const fileOpsRecord = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

		const newLocalSha = this.fit.filterSyncedState(await this.fit.localVault.readFromSource());

		fitLogger.log('[FitPull] Updating local store after pull', {
			oldLocalShaCount: Object.keys(this.fit.localSha || {}).length,
			newLocalShaCount: Object.keys(newLocalSha).length,
			oldRemoteShaCount: Object.keys(this.fit.lastFetchedRemoteSha || {}).length,
			newRemoteShaCount: Object.keys(remoteTreeSha).length,
			localOpsApplied: fileOpsRecord.length,
			localShaAdded: Object.keys(newLocalSha).filter(k => !(this.fit.localSha || {})[k]),
			localShaRemoved: Object.keys(this.fit.localSha || {}).filter(k => !newLocalSha[k]),
			remoteShaAdded: Object.keys(remoteTreeSha).filter(k => !(this.fit.lastFetchedRemoteSha || {})[k]),
			remoteShaRemoved: Object.keys(this.fit.lastFetchedRemoteSha || {}).filter(k => !remoteTreeSha[k]),
			commitShaChanged: this.fit.lastFetchedCommitSha !== latestRemoteCommitSha,
			oldCommitSha: this.fit.lastFetchedCommitSha,
			newCommitSha: latestRemoteCommitSha
		});

		await saveLocalStoreCallback({
			lastFetchedRemoteSha: this.fit.filterSyncedState(remoteTreeSha),
			lastFetchedCommitSha: latestRemoteCommitSha,
			localSha: newLocalSha
		});
		return fileOpsRecord;
	}
}
