import { VaultOperations } from "./vaultOps";
import { Fit } from "./fit";
import { Notice } from "obsidian";
import { compareSha } from "./utils";
import { warn } from "console";
import { LocalStores } from "main";


export type LocalChange = {
    path: string,
    type: string,
    extension? : string
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

    async performPrePushChecks(): Promise<null|[LocalChange[], string]> {
        const {data: latestRef} = await this.fit.getRef(`heads/${this.fit.branch}`)
        const localSha = await this.fit.computeLocalSha()
        const changedFiles = await this.getLocalChanges(localSha)
        if (changedFiles.length == 0) {
            new Notice("No local changes detected.")
            return null
        }
        const latestRemoteCommitSha = latestRef.object.sha;
        if (latestRemoteCommitSha != this.fit.lastFetchedCommitSha) {
            new Notice("Remote changed after last pull/write, please pull again.")
				return null
        }
        return [changedFiles, latestRemoteCommitSha]
    }

    async getLocalChanges(currentLocalSha: {[k: string]: string}): Promise<LocalChange[]> {
        let changedFiles: Array<{path: string, type: string, extension?: string}>;
        // const localSha = await this.fit.computeLocalSha()
        const files = this.vaultOps.vault.getFiles()
		// mark all files as changed if local sha for previous commit is not found
        if (!this.fit.localSha) {
            changedFiles = files.map(f=> {return {
                path: f.path, type: 'changed', extension: f.extension}})
        } else {
            const localChanges = compareSha(currentLocalSha, this.fit.localSha)
            changedFiles = localChanges.flatMap(change=>{
                if (change.status == "removed") {
                    return {path: change.path, type: 'deleted'}
                } else {
                    const file = this.vaultOps.vault.getFileByPath(change.path)
                    if (!file) {
                        warn(`${file} included in local changes (added/modified) but not found`)
                        return []
                    }
                    if (change.status == "added") {
                        return {path: change.path, type: 'created', extension: file.extension}
                    } else {
                        return {path: change.path, type: 'changed', extension: file.extension}
                    }
                }
            })
        }
        return changedFiles
    }

    async pushChangedFilesToRemote(
        changedFiles: LocalChange[], 
        latestRemoteCommitSha: string, 
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>):
        Promise<void> {
            const treeNodes = await Promise.all(changedFiles.map((f) => {
                return this.fit.createTreeNodeFromFile(f)
            }))
            const {data: latestCommit} = await this.fit.getCommit(latestRemoteCommitSha)
            const {data: newTree} = await this.fit.createTree(treeNodes, latestCommit.tree.sha)
            const {data: newCommit} = await this.fit.createCommit(newTree.sha, latestRemoteCommitSha)
            const {data: updatedRef} = await this.fit.updateRef(`heads/${this.fit.branch}`, newCommit.sha)
            const updatedRemoteSha = await this.fit.getRemoteTreeSha(updatedRef.object.sha)
            await saveLocalStoreCallback({
                lastFetchedRemoteSha: updatedRemoteSha, 
                lastFetchedCommitSha: newCommit.sha,
                localSha: await this.fit.computeLocalSha()
            })
            changedFiles.map(({path, type}): void=>{
                const typeToAction = {deleted: "deleted from", created: "added to", changed: "modified on"}
                new Notice(`${path} ${typeToAction[type as keyof typeof typeToAction]} remote.`, 10000)
            })
            new Notice(`Successful pushed to ${this.fit.repo}`)
    }
}