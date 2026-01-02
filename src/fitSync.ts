import { arrayBufferToBase64 } from "obsidian"
import { Fit } from "./fit"
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteChange, RemoteUpdate } from "./fitTypes"
import { RECOGNIZED_TXT_EXT, extractExtension, removeLineEndingsFromBase64String } from "./utils"
import { FitPull } from "./fitPull"
import { FitPush } from "./fitPush"
import { VaultOperations } from "./vaultOps"
import { LocalStores } from "main"
import FitNotice from "./fitNotice"
import { conflictResolutionFolder } from "./const"

export interface IFitSync {
    fit: Fit
}

export type ResolveConflict = {
    noConflict: boolean,
    unresolvedFiles: ClashStatus[],
    fileOpsRecord: FileOpRecord[],
    // diff: any
}

type PreSyncCheckResult =  {
    status: "inSync"
} | {
    status: Exclude<PreSyncCheckResultType, "inSync">
    remoteUpdate: RemoteUpdate
    localChanges: LocalChange[]
    localTreeSha: Record<string, string>
}

type PreSyncCheckResultType = (
    "inSync" |
    "onlyLocalChanged" |
    "onlyRemoteChanged" |
    "onlyRemoteCommitShaChanged" |
    "localAndRemoteChangesCompatible" |
    "localAndRemoteChangesClashed"
)

export class FitSync implements IFitSync {
    fit: Fit
    fitPull: FitPull
    fitPush: FitPush
    vaultOps: VaultOperations
    saveLocalStoreCallback: (path: string, localStore: Partial<LocalStores>) => Promise<void>


    constructor(fit: Fit,
        vaultOps: VaultOperations,
        saveLocalStoreCallback: (path: string, localStore: Partial<LocalStores>)
            => Promise<void>)
    {
        this.fit = fit
        this.fitPull = new FitPull(fit)
        this.fitPush = new FitPush(fit)
        this.vaultOps = vaultOps
        this.saveLocalStoreCallback = saveLocalStoreCallback
    }

    private async performPreSyncChecks(): Promise<PreSyncCheckResult> {
        const currentLocalSha = await this.fit.computeLocalSha()
        const localChanges = await this.fit.getLocalChanges(currentLocalSha)
        const {remoteCommitSha, updated: remoteUpdated} = await this.fit.remoteUpdated();
        if (localChanges.length === 0 && !remoteUpdated) {
            return {status: "inSync"}
        }

        const remoteTreeSha = await this.fit.getRemoteTreeSha(remoteCommitSha)
        const remoteChanges = await this.fit.getRemoteChanges(remoteTreeSha)
        let clashes: ClashStatus[] = [];
        let status: PreSyncCheckResultType

        if (localChanges.length > 0 && !remoteUpdated) {
            status = "onlyLocalChanged"
        } else if (remoteUpdated && localChanges.length === 0 && remoteChanges.length === 0) {
            status = "onlyRemoteCommitShaChanged"
        } else if (localChanges.length === 0 && remoteUpdated) {
            status = "onlyRemoteChanged"
        } else {
            clashes = this.fit.getClashedChanges(localChanges, remoteChanges)
            if (clashes.length === 0) {
                status = "localAndRemoteChangesCompatible"
            } else {
                status =  "localAndRemoteChangesClashed"
            }
        }
        return {
            status,
            remoteUpdate: {
                remoteChanges,
                remoteTreeSha,
                latestRemoteCommitSha: remoteCommitSha,
                clashedFiles: clashes
            },
            localChanges,
            localTreeSha: currentLocalSha
        }
    }

    private generateConflictReport(path: string, localContent: string, remoteContent: string): ConflictReport {
        const detectedExtension = extractExtension(path)

        // assume file encoding is utf8 if extension is not known
        let resolutionStrategy: "utf-8" | "binary" = "utf-8"

        // TODO есть getFileEncoding
        if (detectedExtension && !RECOGNIZED_TXT_EXT.includes(detectedExtension))
            resolutionStrategy = "binary"

        return {
            path,
            resolutionStrategy: resolutionStrategy,
            localContent,
            remoteContent,
        }
    }

    private async moveConflictBinary(srcFile: string) {
        const conflictPath = this.fit.syncPath+srcFile
        const conflictResolutionPath = conflictResolutionFolder + conflictPath

        const excludes = this.fit.excludes

        let isExcluded = false
        if (excludes.length) {
          isExcluded = excludes.some(el => conflictResolutionPath.startsWith(el))
        }

        if (isExcluded)
            return false

        const content = arrayBufferToBase64(
            await this.fit.vaultOps.vault.adapter.readBinary(srcFile)
        )

        await this.fit.vaultOps.writeToLocal(conflictResolutionPath, content)
        await this.fit.vaultOps.deleteFromLocal(conflictPath)

       return true
    }

    private async handleBinaryConflict(path: string, localContent: string, remoteContent: string): Promise<FileOpRecord|null> {
        const conflictPath = this.fit.syncPath+path
        const conflictResolutionPath = conflictResolutionFolder + conflictPath

        const excludes = this.fit.excludes

        let isExcluded = false
        if (excludes.length) {
          isExcluded = excludes.some(el => conflictResolutionPath.startsWith(el))
        }

        if (isExcluded)
            return null

        await Promise.all([
            this.fit.vaultOps.writeToLocal(conflictPath, remoteContent),
            this.fit.vaultOps.writeToLocal(conflictResolutionPath, localContent),
        ])

        // TODO add
        /*
            return {
                path: conflictPath,
                status: "changed"
            }
        */
        return {
            path: conflictResolutionPath,
            status: "created"
        }
    }

    private async handleUTF8Conflict(path: string, localContent: string, remoteContent: string): Promise<FileOpRecord|null> {
        const conflictPath = this.fit.syncPath + path
        const conflictResolutionPath = conflictResolutionFolder + conflictPath

        const excludes = this.fit.excludes

        let isExcluded = false
        if (excludes.length) {
          isExcluded = excludes.some(el => conflictResolutionPath.startsWith(el))
        }

        if (isExcluded)
            return null

        await Promise.all([
            this.fit.vaultOps.writeToLocal(conflictPath, remoteContent),
            this.fit.vaultOps.writeToLocal(conflictResolutionPath, localContent),
        ])

        return {
            path: conflictResolutionPath,
            status: "created"
        }
    }

    private async handleLocalDeletionConflict(path: string, remoteContent: string): Promise<FileOpRecord|null> {
        // const conflictResolutionPath = conflictResolutionFolder + conflictPath
        const conflictResolutionPath = this.fit.syncPath + path

        const excludes = this.fit.excludes

        let isExcluded = false
        if (excludes.length) {
            isExcluded = excludes.some(el => conflictResolutionPath.startsWith(el))
        }

        if (isExcluded)
            return null

        await this.fit.vaultOps.writeToLocal(conflictResolutionPath, remoteContent)

        return {
            path: conflictResolutionPath,
            status: "created"
        }
    }

    private async resolveFileConflict(clash: ClashStatus, latestRemoteFileSha: string): Promise<ConflictResolutionResult | null> {
        if (clash.localStatus === "deleted" && clash.remoteStatus === "REMOVED") {
            return {path: clash.path, noDiff: true}
        } else if (clash.localStatus === "deleted") {
            const remoteContent = await this.fit.getBlob(latestRemoteFileSha)
            const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent)
            // NOTE didn't delete since it's in exclude
            if (!fileOp)
                return null

            return {path: clash.path, noDiff: false, fileOp: fileOp}
        }

        const path = this.fit.syncPath + clash.path

        // NOTE use adapter for files in the .obsidian/...
        const localFileContent = arrayBufferToBase64(
            await this.fit.vaultOps.vault.adapter.readBinary(path)
        )

        if (!latestRemoteFileSha) {
            await this.moveConflictBinary(clash.path)

            // assumes remote file is deleted if sha not found in latestRemoteTreeSha.
            return { path: clash.path, noDiff: true, fileOp: {path:clash.path, status: "changed"} }
        }


        const remoteContent = await this.fit.getBlob(latestRemoteFileSha)
        if (removeLineEndingsFromBase64String(remoteContent) !== removeLineEndingsFromBase64String(localFileContent)) {
            const report = this.generateConflictReport(clash.path, localFileContent, remoteContent)

            let fileOp: FileOpRecord | null
            if (report.resolutionStrategy === "binary") {
                fileOp = await this.handleBinaryConflict(clash.path, report.localContent, report.remoteContent)
            }
            else {
                fileOp = await this.handleUTF8Conflict(clash.path, report.localContent, report.remoteContent)
            }

            // NOTE didn't delete since it's in exclude
            if (!fileOp)
                return null

            return {path: clash.path, noDiff: false, fileOp: fileOp}
        }
        return { path: clash.path, noDiff: true }
    }

    async resolveConflicts(
        clashedFiles: Array<ClashStatus>, latestRemoteTreeSha: Record<string, string>)
            : Promise<ResolveConflict>
        {
            const fileResolutions = await Promise.all(
                clashedFiles.map(
                    async (clash) => {
                        return await this.resolveFileConflict(clash, latestRemoteTreeSha[clash.path])
                    }
                )
            )

            const unresolvedFiles = fileResolutions.map((res, i)=> {
                if (!res?.noDiff) {
                    return clashedFiles[i]
                }
                return null
            }).filter(Boolean) as Array<ClashStatus>

            return {
                noConflict: fileResolutions.every(res=>res?.noDiff),
                unresolvedFiles,
                fileOpsRecord: fileResolutions.map(r => r?.fileOp).filter(Boolean) as FileOpRecord[]
            }
    }

    async syncCompatibleChanges(
        localUpdate: LocalUpdate,
        remoteUpdate: RemoteUpdate,
        syncNotice: FitNotice): Promise<{localOps: LocalChange[], remoteOps: FileOpRecord[]}> {
            let {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
                remoteUpdate.remoteChanges)
            syncNotice.setMessage("Uploading local changes")
            const remoteTree = await this.fit.getTree(localUpdate.parentCommitSha)
            const createCommitResult = await this.fitPush.createCommitFromLocalUpdate(localUpdate, remoteTree)
            let latestRemoteTreeSha: Record<string, string>;
            let latestCommitSha: string;
            let pushedChanges: Array<LocalChange>;
            if (createCommitResult) {
                const {createdCommitSha} = createCommitResult
                const latestRefSha = await this.fit.updateRef(createdCommitSha)
                latestRemoteTreeSha = await this.fit.getRemoteTreeSha(latestRefSha)
                latestCommitSha = createdCommitSha
                pushedChanges = createCommitResult.pushedChanges
            } else {
                latestRemoteTreeSha = remoteUpdate.remoteTreeSha
                latestCommitSha = remoteUpdate.latestRemoteCommitSha
                pushedChanges = []
            }

            syncNotice.setMessage("Writing remote changes to local")

            const basepath = this.fit.syncPath
            addToLocal = this.fit.getAddToLocal(addToLocal)
            deleteFromLocal = this.fit.getDeleteFromLocal(deleteFromLocal)


            const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)
            await this.saveLocalStoreCallback(
                basepath,
                {
                    lastFetchedRemoteSha: latestRemoteTreeSha,
                    lastFetchedCommitSha: latestCommitSha,
                    localSha: await this.fit.computeLocalSha()
                }
            )
            syncNotice.setMessage("Sync successful")
            return {localOps: localFileOpsRecord, remoteOps: pushedChanges}
    }


    async syncWithConflicts(
        localChanges: LocalChange[],
        remoteUpdate: RemoteUpdate,
        syncNotice: FitNotice) : Promise<{unresolvedFiles: ClashStatus[], localOps: LocalChange[], remoteOps: LocalChange[]} | null>
    {
        const {latestRemoteCommitSha, clashedFiles, remoteTreeSha: latestRemoteTreeSha} = remoteUpdate
        const {noConflict, unresolvedFiles, fileOpsRecord} = await this.resolveConflicts(clashedFiles, latestRemoteTreeSha)
        let localChangesToPush: Array<LocalChange> = [];
        let remoteChangesToWrite: Array<RemoteChange>
        if (noConflict) {
            // no conflict detected among clashed files, just pull changes only made on remote and push changes only made on local
            remoteChangesToWrite = remoteUpdate.remoteChanges.filter(c => !localChanges.some(l => l.path === c.path))
            localChangesToPush = localChanges.filter(c => !remoteUpdate.remoteChanges.some(r => r.path === c.path))

        } else {
            syncNotice.setMessage(`Change conflicts detected`)
            // do not modify unresolved files locally
            remoteChangesToWrite = remoteUpdate.remoteChanges.filter(c => !unresolvedFiles.some(l => l.path === c.path))

            // push change even if they are in unresolved files, so remote has a record of them,
            // so user can resolve later by modifying local and push again
            localChangesToPush = localChanges
        }
        let {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(remoteChangesToWrite)
        const syncLocalUpdate = {
            localChanges: localChangesToPush,
            parentCommitSha: latestRemoteCommitSha
        }
        const pushResult = await this.fitPush.pushChangedFilesToRemote(syncLocalUpdate)
        let pushedChanges: LocalChange[];
        let lastFetchedCommitSha: string;
        let lastFetchedRemoteSha: Record<string, string>;
        if (pushResult) {
            pushedChanges = pushResult.pushedChanges
            lastFetchedCommitSha = pushResult.lastFetchedCommitSha
            lastFetchedRemoteSha = pushResult.lastFetchedRemoteSha
        } else {
            // did not push any changes
            pushedChanges = []
            lastFetchedCommitSha = remoteUpdate.latestRemoteCommitSha
            lastFetchedRemoteSha = remoteUpdate.remoteTreeSha
        }

        const basepath = this.fit.syncPath
        addToLocal = this.fit.getAddToLocal(addToLocal)
        deleteFromLocal = this.fit.getDeleteFromLocal(deleteFromLocal)

        const localFileOpsRecord = await this.vaultOps.updateLocalFiles(
            addToLocal,
            deleteFromLocal
        )

        await this.saveLocalStoreCallback(
            basepath,
        {
            lastFetchedRemoteSha,
            lastFetchedCommitSha,
            localSha: await this.fit.computeLocalSha()
        })
        const ops = localFileOpsRecord.concat(fileOpsRecord)
        if (unresolvedFiles.length === 0) {
            syncNotice.setMessage(`Sync successful`)
        } else if (unresolvedFiles.some(f => f.remoteStatus !== "REMOVED")) {
            // let user knows remote file changes have been written to _fit if non-deletion change on remote clashed with local changes
            syncNotice.setMessage(`Synced with remote, unresolved conflicts written to ${conflictResolutionFolder}`)
        } else {
            syncNotice.setMessage(`Synced with remote, ignored remote deletion of locally changed files`)
        }
        return {unresolvedFiles, localOps: ops, remoteOps: pushedChanges}
    }

    private async unresolvedChangesConflicts(): Promise<boolean> {
        return await this.vaultOps.vault.adapter.exists(conflictResolutionFolder)
    }

    async sync(syncNotice: FitNotice):
            Promise<{
                    ops: Array<{heading: string, ops: FileOpRecord[]}>,
                    clash: ClashStatus[],
                    // basepath: string
                } | void
            >
    {
        syncNotice.setMessage("Performing pre sync checks.")
        if (await this.unresolvedChangesConflicts()) {
            syncNotice.setMessage(`There are unresolved files: pls, resolve files in: ${conflictResolutionFolder}.`)
            return
        }

        const preSyncCheckResult = await this.performPreSyncChecks();

        // convert to switch statement later on for better maintainability
        if (preSyncCheckResult.status === "inSync") {
            syncNotice.setMessage("Sync successful")
            return
        }

        if (preSyncCheckResult.status === "onlyRemoteCommitShaChanged") {
            const { latestRemoteCommitSha } = preSyncCheckResult.remoteUpdate
            await this.saveLocalStoreCallback(
                this.fit.syncPath,
                {lastFetchedCommitSha: latestRemoteCommitSha}
            )

            syncNotice.setMessage("Sync successful")
            return
        }

        const remoteUpdate = preSyncCheckResult.remoteUpdate
        if (preSyncCheckResult.status === "onlyRemoteChanged") {
            const fileOpsRecord = await this.fitPull.pullRemoteToLocal(
                remoteUpdate,
                this.saveLocalStoreCallback
            )

            syncNotice.setMessage("Sync successful")

            return {
                ops: [{heading: "Local file updates:", ops: fileOpsRecord}],
                clash: [],
                // basepath: this.fit.syncPath
            }
        }

        const {localChanges, localTreeSha} = preSyncCheckResult
        const localUpdate = {
            localChanges,
            parentCommitSha: remoteUpdate.latestRemoteCommitSha
        }
        if (preSyncCheckResult.status === "onlyLocalChanged") {
            syncNotice.setMessage("Uploading local changes")
            const pushResult = await this.fitPush.pushChangedFilesToRemote(localUpdate)
            syncNotice.setMessage("Sync successful")
            if (pushResult) {
                await this.saveLocalStoreCallback(
                    this.fit.syncPath,
                    {
                        localSha: localTreeSha,
                        lastFetchedRemoteSha: pushResult.lastFetchedRemoteSha,
                        lastFetchedCommitSha: pushResult.lastFetchedCommitSha
                    }
                )
                return {
                    ops: [{heading: "Local file updates:", ops: pushResult.pushedChanges}],
                    clash: [],
                    // basepath: this.fit.syncPath
                }
            }
            return
        }

        // do both pull and push (orders of execution different from pullRemoteToLocal and
        // pushChangedFilesToRemote to make this more transaction like, i.e. maintain original
        // state if the transaction failed) If you have ideas on how to make this more transaction-like,
        //  please open an issue on the fit repo
        if (preSyncCheckResult.status === "localAndRemoteChangesCompatible") {
            const {localOps, remoteOps} = await this.syncCompatibleChanges(
                localUpdate, remoteUpdate, syncNotice)
                return ({
                    ops: [
                        {heading: "Local file updates:", ops: localOps},
                        {heading: "Remote file updates:", ops: remoteOps},
                    ],
                    clash: [],
                    // basepath: this.fit.syncPath
                })
        }

        if (preSyncCheckResult.status === "localAndRemoteChangesClashed") {
            const conflictResolutionResult = await this.syncWithConflicts(
                localUpdate.localChanges, remoteUpdate, syncNotice
            )

            if (conflictResolutionResult) {
                const {unresolvedFiles, localOps, remoteOps} = conflictResolutionResult

                return ({
                    ops:[
                        {heading: "Local file updates:", ops: localOps},
                        {heading: "Remote file updates:", ops: remoteOps},
                    ],
                    clash: unresolvedFiles,
                    // basepath: this.fit.syncPath
                })
            }
        }
    }
}
