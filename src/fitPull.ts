import { VaultOperations } from "./vaultOps";
import { getFileEncoding } from "./utils";
import { Fit } from "./fit";

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