import { showFileOpsRecord } from "./utils";
import { Fit } from "./fit";
import { LocalStores } from "main";
import { FileOpRecord, LocalChange, RemoteChange, RemoteUpdate } from "./fitTypes";

type PrePullCheckResultType = (
    "localCopyUpToDate" | 
    "localChangesClashWithRemoteChanges" | 
    "remoteChangesCanBeMerged" | 
    "noRemoteChangesDetected"
)

type PrePullCheckResult = (
    { status: "localCopyUpToDate", remoteUpdate: null } | 
    { status: Exclude<PrePullCheckResultType, "localCopyUpToDate">, remoteUpdate: RemoteUpdate }
);

export interface IFitPull {
    fit: Fit
}

export class FitPull implements IFitPull {
    fit: Fit
    

    constructor(fit: Fit) {
        this.fit = fit
    }

    // return null if remote doesn't have updates otherwise, return the latestRemoteCommitSha
    async remoteHasUpdates(): Promise<string | null> {
        const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha()
        if (latestRemoteCommitSha == this.fit.lastFetchedCommitSha) {
            return null
        }
        return latestRemoteCommitSha
    }

    async performPrePullChecks(localChanges?: LocalChange[]): Promise<PrePullCheckResult> {
        const latestRemoteCommitSha = await this.remoteHasUpdates()
        if (!latestRemoteCommitSha) {
            return {status: "localCopyUpToDate", remoteUpdate: null}
        }
        if (!localChanges) {
            localChanges = await this.fit.getLocalChanges()
        }
        const remoteTreeSha = await this.fit.getRemoteTreeSha(latestRemoteCommitSha)
        const remoteChanges = await this.fit.getRemoteChanges(remoteTreeSha)
        const clashedFiles = this.fit.getClashedChanges(localChanges, remoteChanges)
        // TODO handle clashes without completely blocking pull
        const prePullCheckStatus = (
            (remoteChanges.length > 0) ? (
                (clashedFiles.length > 0) ? "localChangesClashWithRemoteChanges" : "remoteChangesCanBeMerged"):
                "noRemoteChangesDetected")
        
        return {
            status: prePullCheckStatus, 
            remoteUpdate: {
                remoteChanges, remoteTreeSha, latestRemoteCommitSha, clashedFiles
            }
        }
    }

    // Get changes from remote, pathShaMap is coupled to the Fit plugin design
    async getRemoteNonDeletionChangesContent(pathShaMap: Record<string, string>) {
        const remoteChanges = Object.entries(pathShaMap).map(async ([path, file_sha]) => {
            const content = await this.fit.getBlob(file_sha);
            return {path, content};
        })
        return await Promise.all(remoteChanges)
    }

    async prepareChangesToExecute(remoteChanges: RemoteChange[]) {
        const deleteFromLocal = remoteChanges.filter(c=>c.status=="REMOVED").map(c=>c.path)
			const changesToProcess = remoteChanges.filter(c=>c.status!="REMOVED").reduce(
				(acc, change) => {
                    acc[change.path] = change.currentSha as string;
					return acc;
                }, {} as Record<string, string>);

		const addToLocal = await this.getRemoteNonDeletionChangesContent(changesToProcess)
        return {addToLocal, deleteFromLocal}
    }

    async pullRemoteToLocal(
        remoteUpdate: RemoteUpdate,
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>): Promise<FileOpRecord[]> {
            const {remoteChanges, remoteTreeSha, latestRemoteCommitSha} = remoteUpdate
            const {addToLocal, deleteFromLocal} = await this.prepareChangesToExecute(remoteChanges)
			
			const fileOpsRecord = await this.fit.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal);
			await saveLocalStoreCallback({
                lastFetchedRemoteSha: remoteTreeSha, 
                lastFetchedCommitSha: latestRemoteCommitSha,
                localSha: await this.fit.computeLocalSha()
            })
            showFileOpsRecord([{heading: "Local file updates:", ops: fileOpsRecord}])
            return fileOpsRecord
    }
}