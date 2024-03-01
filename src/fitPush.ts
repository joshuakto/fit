import { VaultOperations } from "./vaultOps";
import { Fit } from "./fit";
import { Notice } from "obsidian";

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
}