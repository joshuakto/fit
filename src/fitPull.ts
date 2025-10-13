import { Fit } from "./fit";
import { LocalStores } from "main";
import { FileOpRecord, LocalChange, RemoteChange, RemoteUpdate } from "./fitTypes";

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
		const deleteFromLocal = remoteChanges.filter(c=>c.status=="REMOVED").map(c=>c.path);
		const changesToProcess = remoteChanges.filter(c=>c.status!="REMOVED").reduce(
			(acc, change) => {
				acc[change.path] = change.currentSha as string;
				return acc;
			}, {} as Record<string, string>);

		const addToLocal = await this.getRemoteNonDeletionChangesContent(changesToProcess);
		return {addToLocal, deleteFromLocal};
	}

	async pullRemoteToLocal(
		remoteUpdate: RemoteUpdate,
		saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>): Promise<FileOpRecord[]> {
		const {remoteChanges, remoteTreeSha, latestRemoteCommitSha} = remoteUpdate;
		const {addToLocal, deleteFromLocal} = await this.prepareChangesToExecute(remoteChanges);

		const fileOpsRecord = await this.fit.localVault.applyChanges(addToLocal, deleteFromLocal);

		await saveLocalStoreCallback({
			lastFetchedRemoteSha: remoteTreeSha,
			lastFetchedCommitSha: latestRemoteCommitSha,
			localSha: await this.fit.localVault.readFromSource()
		});
		return fileOpsRecord;
	}
}
