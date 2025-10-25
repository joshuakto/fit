import { Fit } from "./fit";
import { LocalStores } from "main";
import { FileOpRecord, LocalChange, RemoteChange, RemoteUpdate } from "./fitTypes";
import { fitLogger } from "./logger";
import { FileContent } from "./contentEncoding";

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
	async getRemoteNonDeletionChangesContent(pathShaMap: Record<string, string>): Promise<Array<{path: string, content: FileContent}>> {
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
		// Batch-check existence for all files not in cache (both adds and deletes)
		const addPathsToCheck = addToLocal
			.filter(c => this.fit.shouldSyncPath(c.path)) // Skip protected paths
			.filter(c => !this.fit.localSha.hasOwnProperty(c.path))
			.map(c => c.path);

		const deletePathsToCheck = deleteFromLocal
			.filter(p => this.fit.shouldSyncPath(p)) // Skip protected paths
			.filter(p => !this.fit.localSha.hasOwnProperty(p));

		// Combine and deduplicate paths to check
		const allPathsToCheck = Array.from(new Set([...addPathsToCheck, ...deletePathsToCheck]));
		const existenceMap = await this.fit.localVault.statPaths(allPathsToCheck);

		const resolvedChanges: Array<{path: string, content: FileContent}> = [];
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
				if (stat !== null) {
					// File exists - treat as clash
					fitLogger.log('[FitPull] File exists locally but not in cache - saving to _fit/ for safety', {
						path: change.path,
						reason: 'Possible tracking state inconsistency (version migration or bug)'
					});
					resolvedChanges.push({
						path: `_fit/${change.path}`,
						content: change.content
					});
					continue; // Don't risk overwriting local version
				}
				// File doesn't exist locally - safe to write directly
				fitLogger.log('[FitPull] File not in cache but also not on disk - writing directly', {
					path: change.path
				});
			}

			// Normal file or no conflict - add as-is
			resolvedChanges.push({path: change.path, content: change.content});
		}

		// SAFETY: Never delete protected or untracked files from local
		const safeDeleteFromLocal = [];
		for (const path of deleteFromLocal) {
			// Skip deletion of protected paths (shouldn't exist locally, but be safe)
			if (!this.fit.shouldSyncPath(path)) {
				fitLogger.log('[FitPull] Skipping deletion of protected path', {
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
				if (stat !== null) {
					// File exists but not tracked - warn user, don't delete
					fitLogger.log('[FitPull] Skipping deletion - file exists but not in cache', {
						path,
						reason: 'Cannot verify safe to delete (possible tracking state inconsistency)'
					});
				} else {
					// File doesn't exist - deletion already done, no action needed
					fitLogger.log('[FitPull] File already deleted locally', {
						path,
						reason: 'Not in cache and not on disk'
					});
				}
				continue; // Skip deletion in both cases
			}

			safeDeleteFromLocal.push(path); // Safe to delete
		}

		return {addToLocal: resolvedChanges, deleteFromLocal: safeDeleteFromLocal};
	}

	// TODO: File/folder conflict handling
	//
	// ISSUE: LocalVault.applyChanges() can fail with VaultError.filesystem when:
	// - Trying to create file "foo" when folder "foo/" already exists
	// - Trying to create file "foo/bar" when file "foo" already exists
	//
	// Currently, these errors propagate up and fail the sync. FakeLocalVault
	// correctly simulates this behavior in tests, so tests fail when this occurs.
	//
	// APPROACHES TO FIX:
	//
	// 1. Add wrapper method in FitPull (try/catch around applyChanges):
	//    - Catch VaultError.filesystem errors
	//    - Check if error is file/folder conflict by examining vault state
	//    - If conflict: save remote file to _fit/ instead
	//    - If other error: re-throw
	//    - PROS: Keeps conflict handling logic in FitPull layer
	//    - CONS: Must be called from ALL sync paths (currently 3 places):
	//      * pullRemoteToLocal() (only remote changed) - line 215
	//      * syncCompatibleChanges() (compatible changes) - fitSync.ts:356
	//      * syncWithConflicts() (clashed changes) - fitSync.ts:425
	//
	// 2. Move detection/handling into LocalVault.applyChanges():
	//    - Pre-check for file/folder conflicts before applying changes
	//    - Return special status in FileOpRecord for conflicts
	//    - Caller decides where to save conflicted files
	//    - PROS: Centralized, handles all sync paths automatically
	//    - CONS: Violates separation of concerns (LocalVault shouldn't know about _fit/)
	//
	// 3. Consolidate sync paths first, then add wrapper:
	//    - Refactor syncCompatibleChanges() and syncWithConflicts() to share code
	//    - Reduce duplication so only ONE place calls applyChanges()
	//    - Then add wrapper at that single call site
	//    - PROS: Fixes underlying duplication problem
	//    - CONS: Larger refactor, higher risk
	//
	// RECOMMENDATION: Option 3 (consolidate code paths first)
	// See detailed code path duplication analysis in fitSync.ts above syncCompatibleChanges().

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
			lastFetchedRemoteSha: remoteTreeSha, // Unfiltered - must track ALL remote files to detect changes
			lastFetchedCommitSha: latestRemoteCommitSha,
			localSha: newLocalSha // Filtered - excludes protected paths and untracked files
		});
		return fileOpsRecord;
	}
}
