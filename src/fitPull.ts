import { VaultOperations } from "./vaultOps";
import { getFileEncoding } from "./utils";
import { Fit } from "./fit";
import { Notice } from "obsidian";

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

    async performPrePullChecks(): Promise<boolean> {
        const {data: latestRef} = await this.fit.getRef(`heads/${this.fit.branch}`)
        const latestRemoteCommitSha = latestRef.object.sha;
        if (latestRemoteCommitSha == this.fit.lastFetchedCommitSha) {
            new Notice("Local copy already up to date")
            return false
        }
        return true
    }

    // Get changes from remote, pathShaMap is coupled to the Fit plugin design
    async getRemoteNonDeletionChanges(pathShaMap: Record<string, string>) {
        const remoteChanges = Object.entries(pathShaMap).map(async ([path, file_sha]) => {
            const encoding = getFileEncoding(path)
            const {data} = await this.fit.getBlob(file_sha);
            const isBinary = encoding == "base64"
            const content = isBinary ? data.content : atob(data.content);
            return {path, content, encoding};
        })
        return await Promise.all(remoteChanges)
    }
}