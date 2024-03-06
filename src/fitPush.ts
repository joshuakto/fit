import { VaultOperations } from "./vaultOps";
import { Fit } from "./fit";
import { Notice } from "obsidian";
import { LocalStores } from "main";


export type LocalFileStatus = "deleted" | "created" | "changed"

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


    async performPrePushChecks(): Promise<null|LocalUpdate> {
        const localTreeSha = await this.fit.computeLocalSha()
        const localChanges = await this.fit.getLocalChanges(localTreeSha)
        if (localChanges.length == 0) {
            new Notice("No local changes detected.")
            return null
        }
        const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha();
        if (latestRemoteCommitSha != this.fit.lastFetchedCommitSha) {
            new Notice("Remote changed after last pull/write, please pull again.")
				return null
        }
        return {localChanges, localTreeSha, parentCommitSha: latestRemoteCommitSha}
    }

    async pushChangedFilesToRemote(
        localUpdate: LocalUpdate,
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>):
        Promise<void> {
            const {localChanges, localTreeSha, parentCommitSha} = localUpdate;
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