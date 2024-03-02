import { VaultOperations } from "./vaultOps";
import { ChangeType, compareSha, getFileEncoding } from "./utils";
import { Fit } from "./fit";
import { Notice } from "obsidian";
import { LocalStores } from "main";

export type RemoteChange = {
    path: string,
    status: ChangeType,
    currentSha : string
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

    async getLocalChanges(): Promise<{path: string, status: ChangeType}[]> {
        if (!this.fit.localSha) {
            // assumes every local files are created if no localSha is found
            return this.vaultOps.vault.getFiles().map(f => {
                return {path: f.path, status: "added" as ChangeType}})
        }
        const currentLocalSha = await this.fit.computeLocalSha()
        const localChanges = compareSha(currentLocalSha, this.fit.localSha)
        return localChanges
    }

    async getRemoteChanges(
        latestRemoteCommitSha: string): 
        Promise<[{path: string, status: ChangeType, currentSha: string}[], {[k: string]: string}]> {
            const remoteTreeSha = await this.fit.getRemoteTreeSha(latestRemoteCommitSha)
            if (!this.fit.lastFetchedRemoteSha) {
                Object.keys(remoteTreeSha).map(path=>{
                    return {path, status: "added" as ChangeType}
                })
            }
            const remoteChanges = compareSha(remoteTreeSha, this.fit.lastFetchedRemoteSha)
            return [remoteChanges, remoteTreeSha]
    }

    getClashedChanges(localChangePaths: Array<string>, remoteChangePaths: Array<string>) {
        const clashedFiles: Array<string> = localChangePaths.filter(path => remoteChangePaths.includes(path))
        const remoteOnly: Array<string> = remoteChangePaths.filter(path => !localChangePaths.includes(path))
        return {clashedFiles, remoteOnly}
    }

    // return null if remote doesn't have updates otherwise, return the latestRemoteCommitSha
    async remoteHasUpdates(): Promise<string | null> {
        const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha()
        if (latestRemoteCommitSha == this.fit.lastFetchedCommitSha) {
            return null
        }
        return latestRemoteCommitSha
    }

    async performPrePullChecks(): Promise<null | [
        RemoteChange[], {[k:string]: string}, string
    ]> {
        const latestRemoteCommitSha = await this.remoteHasUpdates()
        if (!latestRemoteCommitSha) {
            new Notice("Local copy already up to date")
            return null
        }
        const localChanges = await this.getLocalChanges()
        const [remoteChanges, remoteSha] = await this.getRemoteChanges(latestRemoteCommitSha)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const {clashedFiles, remoteOnly} = this.getClashedChanges(localChanges.map(c=>c.path), remoteChanges.map(c=>c.path))
        // TODO handle clashes without completely blocking pull
        if (clashedFiles.length > 0) {
            new Notice("Unsaved local changes clash with remote changes, aborting.");
            console.log("clashed files:")
            console.log(clashedFiles)
            return null
        }
        return [remoteChanges, remoteSha, latestRemoteCommitSha]
    }

    // Get changes from remote, pathShaMap is coupled to the Fit plugin design
    async getRemoteNonDeletionChangesContent(pathShaMap: Record<string, string>) {
        const remoteChanges = Object.entries(pathShaMap).map(async ([path, file_sha]) => {
            const encoding = getFileEncoding(path)
            const {data} = await this.fit.getBlob(file_sha);
            const isBinary = encoding == "base64"
            const content = isBinary ? data.content : atob(data.content);
            return {path, content, encoding};
        })
        return await Promise.all(remoteChanges)
    }

    async pullRemoteToLocal(
        remoteChanges: RemoteChange[], 
        remoteSha: {[k:string]: string}, 
        latestRemoteCommitSha: string,
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>): 
        Promise<void> {
            const deleteFromLocal = remoteChanges.filter(c=>c.status=="removed").map(c=>c.path)
			const changesToProcess = remoteChanges.filter(c=>c.status!="removed").reduce(
				(acc, change) => {
					acc[change.path] = change.currentSha;
					return acc;
				}, {} as Record<string, string>);

			const addToLocal = await this.getRemoteNonDeletionChangesContent(changesToProcess)
			
			// TODO: when there are clashing local changes, prompt user for confirmation before proceeding
			await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal);
			await saveLocalStoreCallback({
                lastFetchedRemoteSha: remoteSha, 
                lastFetchedCommitSha: latestRemoteCommitSha,
                localSha: await this.fit.computeLocalSha()
            })
			new Notice("Pull complete, local copy up to date.")
    }
}