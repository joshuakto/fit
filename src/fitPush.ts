import { VaultOperations } from "./vaultOps";
import { Fit } from "./fit";
import { Notice } from "obsidian";
import { LocalStores } from "main";

export type LocalFileStatus = "deleted" | "created" | "changed"

type PrePushCheckResultType = (
    "noLocalChangesDetected" | 
    "remoteChanged" | 
    "localChangesCanBePushed"
)

type PrePushCheckResult = (
    { status: "noLocalChangesDetected", localUpdate: null } | 
    { status: Exclude<PrePushCheckResultType, "noLocalChangesDetected">, localUpdate: LocalUpdate }
);

export type LocalChange = {
    path: string,
    status: LocalFileStatus,
    extension? : string
}

type LocalUpdate = {
    localChanges: LocalChange[],
    localTreeSha: Record<string, string>,
    parentCommitSha: string
}

export interface IFitPush {
    localSha: Record<string, string>
    vaultOps: VaultOperations
    fit: Fit
}

export class FitPush implements IFitPush {
    localSha: Record<string, string>;
    vaultOps: VaultOperations;
    fit: Fit
    

    constructor(fit: Fit, vaultOps: VaultOperations) {
        this.vaultOps = vaultOps
        this.fit = fit
    }


    async performPrePushChecks(): Promise<PrePushCheckResult> {
        const localTreeSha = await this.fit.computeLocalSha()
        const localChanges = await this.fit.getLocalChanges(localTreeSha)
        if (localChanges.length == 0) {
            return {status: "noLocalChangesDetected", localUpdate: null}
        }
        const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha();
        const status = (
            (latestRemoteCommitSha != this.fit.lastFetchedCommitSha) ? 
            "remoteChanged" : "localChangesCanBePushed"
        )
        return {
            status,
            localUpdate: {localChanges, localTreeSha, parentCommitSha: latestRemoteCommitSha}
        }
    }

    async createCommitFromLocalUpdate(localUpdate: LocalUpdate): Promise<string> {
        const {localChanges, parentCommitSha} = localUpdate
        const treeNodes = await Promise.all(localChanges.map((f) => {
            return this.fit.createTreeNodeFromFile(f)
        }))
        const latestRemoteCommitTreeSha = await this.fit.getCommitTreeSha(parentCommitSha)
        // Keep these console.log for debugging until finding out what is causing this bug casused by this.fit.createTree api call: 
        // Uncaught (in promise) HttpError: GitRPC::BadObjectState - https://docs.github.com/rest/git/trees#create-a-tree
        console.log("created treeNodes:")
        console.log(treeNodes)
        console.log(`latest remote commit sha: ${parentCommitSha}`)
        console.log(`base tree sha: ${latestRemoteCommitTreeSha}`)
        const createdTreeSha = await this.fit.createTree(treeNodes, latestRemoteCommitTreeSha)
        const createdCommitSha = await this.fit.createCommit(createdTreeSha, parentCommitSha)
        return createdCommitSha
    }



    async pushChangedFilesToRemote(
        localUpdate: LocalUpdate,
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>):
        Promise<void> {
            const {localChanges, localTreeSha} = localUpdate;
            const createdCommitSha = await this.createCommitFromLocalUpdate(localUpdate)
            const updatedRefSha = await this.fit.updateRef(createdCommitSha)
            const updatedRemoteTreeSha = await this.fit.getRemoteTreeSha(updatedRefSha)

            await saveLocalStoreCallback({
                lastFetchedRemoteSha: updatedRemoteTreeSha, 
                lastFetchedCommitSha: createdCommitSha,
                localSha: localTreeSha
            })

            localChanges.map(({path, status}): void=>{
                const statusToAction = {deleted: "deleted from", created: "added to", changed: "modified on"}
                new Notice(`${path} ${statusToAction[status]} remote.`, 10000)
            })
    }
}