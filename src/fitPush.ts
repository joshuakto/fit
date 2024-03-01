import { VaultOperations } from "./vaultOps";
import { Fit } from "./fit";
import { Notice } from "obsidian";
import { compareSha } from "./utils";
import { warn } from "console";

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

    async performPrePushChecks(): Promise<boolean> {
        const {data: latestRef} = await this.fit.getRef(`heads/${this.fit.branch}`)
        const latestRemoteCommitSha = latestRef.object.sha;
        if (latestRemoteCommitSha != this.fit.lastFetchedCommitSha) {
            new Notice("Remote changed after last pull/write, please pull again.")
				return false
        }
        return true
    }

    async getLocalChanges(currentLocalSha: {[k: string]: string}): Promise<{path: string, type: string, extension?: string}[]> {
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
}