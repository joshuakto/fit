import { VaultOperations } from "./vaultOps";
import { RemoteChangeType, compareSha } from "./utils";
import { Fit } from "./fit";
import { LocalStores } from "main";
import { LocalChange } from "./fitPush";

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

export type RemoteChange = {
    path: string,
    status: RemoteChangeType,
    currentSha?: string
}

export type RemoteUpdate = {
    remoteChanges: RemoteChange[],
    remoteTreeSha: Record<string, string>, 
    latestRemoteCommitSha: string,
    clashedFiles: Array<string>
}

export interface IFitPull {
    vaultOps: VaultOperations
    fit: Fit
}

export class FitPull implements IFitPull {
    vaultOps: VaultOperations;
    fit: Fit
    

    constructor(fit: Fit, vaultOps: VaultOperations) {
        this.vaultOps = vaultOps
        this.fit = fit
    }

    async getRemoteChanges(remoteTreeSha: {[k: string]: string}): Promise<RemoteChange[]> {
            if (!this.fit.lastFetchedRemoteSha) {
                Object.keys(remoteTreeSha).map(path=>{
                    return {path, status: "ADDED" as RemoteChangeType}
                })
            }
            const remoteChanges = compareSha(
                remoteTreeSha, this.fit.lastFetchedRemoteSha, "remote")
            return remoteChanges
    }

    getClashedChanges(localChanges: LocalChange[], remoteChanges:RemoteChange[]): string[] {
        const localChangePaths = localChanges.map(c=>c.path)
        const remoteChangePaths = remoteChanges.map(c=>c.path)
        const clashedFiles: string[] = localChangePaths.filter(
            path => remoteChangePaths.includes(path))
        return clashedFiles
    }

    // return null if remote doesn't have updates otherwise, return the latestRemoteCommitSha
    async remoteHasUpdates(): Promise<string | null> {
        const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha()
        if (latestRemoteCommitSha == this.fit.lastFetchedCommitSha) {
            return null
        }
        return latestRemoteCommitSha
    }

    async performPrePullChecks(): Promise<PrePullCheckResult> {
        const latestRemoteCommitSha = await this.remoteHasUpdates()
        if (!latestRemoteCommitSha) {
            return {status: "localCopyUpToDate", remoteUpdate: null}
        }
        const localChanges = await this.fit.getLocalChanges()
        const remoteTreeSha = await this.fit.getRemoteTreeSha(latestRemoteCommitSha)
        const remoteChanges = await this.getRemoteChanges(remoteTreeSha)
        const clashedFiles = this.getClashedChanges(localChanges, remoteChanges)
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
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>): 
        Promise<void> {
            const {remoteChanges, remoteTreeSha, latestRemoteCommitSha} = remoteUpdate
            const {addToLocal, deleteFromLocal} = await this.prepareChangesToExecute(remoteChanges)
			
			// TODO: when there are clashing local changes, prompt user for confirmation before proceeding
			await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal);
			await saveLocalStoreCallback({
                lastFetchedRemoteSha: remoteTreeSha, 
                lastFetchedCommitSha: latestRemoteCommitSha,
                localSha: await this.fit.computeLocalSha()
            })
    }
}