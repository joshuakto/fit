import { VaultOperations } from "./vaultOps";
import { Fit } from "./fit";
import { Notice, TFile } from "obsidian";
import { compareSha } from "./utils";
import { warn } from "console";
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
        const localChanges = await this.getLocalChanges(localTreeSha)
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

    async getLocalChanges(currentLocalSha: Record<string, string>): Promise<LocalChange[]> {
        let changedFiles: LocalChange[];
        // const localSha = await this.fit.computeLocalSha()
        const files = this.vaultOps.vault.getFiles()
		// mark all files as changed if local sha for previous commit is not found
        if (!this.fit.localSha) {
            changedFiles = files.map(f=> {return {
                path: f.path, status: 'changed', extension: f.extension}})
        } else {
            const localChanges = compareSha(currentLocalSha, this.fit.localSha, "local")
            changedFiles = localChanges.flatMap(change=>{
                if (change.status == "deleted") {
                    return {path: change.path, status: change.status}
                } else {
                    // adopted getAbstractFileByPath for mobile compatiability
                    const file = this.vaultOps.vault.getAbstractFileByPath(change.path)
                    if (!file) {
                        warn(`${file} included in local changes (added/modified) but not found`)
                        return []
                    }
                    if (file instanceof TFile) {
                        return {path: change.path, status: change.status, extension: file.extension}
                    }
                    throw new Error(`Expected ${file.path} to be of type TFile but got type ${typeof file}`);
                }
            })
        }
        return changedFiles
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