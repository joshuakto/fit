import { arrayBufferToBase64 } from "obsidian"
import { Fit } from "./fit"
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, RemoteUpdate } from "./fitTypes"
import { RECOGNIZED_BINARY_EXT, extractExtension, removeLineEndingsFromBase64String } from "./utils"

export interface IFitSync {
    fit: Fit
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
    

    constructor(fit: Fit) {
        this.fit = fit
    }

    async performPreSyncChecks(): Promise<PreSyncCheckResult> {
        const currentLocalSha = await this.fit.computeLocalSha()
        const localChanges = await this.fit.getLocalChanges(currentLocalSha)
        const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha()
        const remoteChanged = latestRemoteCommitSha !== this.fit.lastFetchedCommitSha
        if (localChanges.length === 0 && !remoteChanged) {
            return {status: "inSync"}
        }
        const remoteTreeSha = await this.fit.getRemoteTreeSha(latestRemoteCommitSha)
        const remoteChanges = await this.fit.getRemoteChanges(remoteTreeSha)
        let clashes: ClashStatus[] | null = null;
        let status: PreSyncCheckResultType
        if (localChanges.length > 0 && !remoteChanged) {
            status = "onlyLocalChanged"
        } else if (remoteChanged && localChanges.length === 0 && remoteChanges.length === 0) {
            status = "onlyRemoteCommitShaChanged"
        } else if (localChanges.length === 0 && remoteChanged) {
            status = "onlyRemoteChanged"
        } else {
            clashes = this.fit.getClashedChanges(localChanges, remoteChanges)
            console.log(clashes)
            console.log(localChanges)
            console.log(remoteChanges)
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
                latestRemoteCommitSha, 
                clashedFiles: clashes ? clashes : []
            }, 
            localChanges, 
            localTreeSha: currentLocalSha
        }
    }

    generateConflictReport(path: string, localContent: string, remoteContent: string): ConflictReport {
        const detectedExtension = extractExtension(path)
        if (detectedExtension && RECOGNIZED_BINARY_EXT.includes(detectedExtension)) {
            return {
                path,
                resolutionStrategy: "binary",
                remoteContent
            }
        }
        // assume file encoding is utf8 if extension is not known
        return {
            path,
            resolutionStrategy: "utf-8",
            localContent,
            remoteContent,
        }
    }

    async handleBinaryConflict(path: string, remoteContent: string): Promise<FileOpRecord> {
        const conflictResolutionFolder = "_fit"
        const conflictResolutionPath = `${conflictResolutionFolder}/${path}`
        await this.fit.vaultOps.ensureFolderExists(conflictResolutionPath)
        await this.fit.vaultOps.writeToLocal(conflictResolutionPath, remoteContent)
        return {
            path: conflictResolutionPath,
            status: "created"
        }

    }

    async handleUTF8Conflict(path: string, localContent: string, remoteConent: string): Promise<FileOpRecord> {
        const conflictResolutionFolder = "_fit"
        const conflictResolutionPath = `${conflictResolutionFolder}/${path}`
        this.fit.vaultOps.ensureFolderExists(conflictResolutionPath)
        this.fit.vaultOps.writeToLocal(conflictResolutionPath, remoteConent)
        return {
            path: conflictResolutionPath,
            status: "created"
        }
    }

    async handleLocalDeletionConflict(path: string, remoteContent: string): Promise<FileOpRecord> {
        const conflictResolutionFolder = "_fit"
        this.fit.vaultOps.ensureFolderExists(conflictResolutionFolder)
        const conflictResolutionPath = `${conflictResolutionFolder}/${path}`
        this.fit.vaultOps.writeToLocal(conflictResolutionPath, remoteContent)
        return {
            path: conflictResolutionPath,
            status: "created"
        }
    }

    async resolveFileConflict(clash: ClashStatus, latestRemoteFileSha: string): Promise<ConflictResolutionResult> {
        if (clash.localStatus === "deleted" && clash.remoteStatus === "REMOVED") {
            return {path: clash.path, noDiff: true}
        } else if (clash.localStatus === "deleted") {
            const remoteContent = await this.fit.getBlob(latestRemoteFileSha)
            const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContent)
            return {path: clash.path, noDiff: false, fileOp: fileOp}
        }

        const localFile = await this.fit.vaultOps.getTFile(clash.path)
        const localFileContent = arrayBufferToBase64(await this.fit.vaultOps.vault.readBinary(localFile))
        
        if (latestRemoteFileSha) {
            const remoteContent = await this.fit.getBlob(latestRemoteFileSha)
            if (removeLineEndingsFromBase64String(remoteContent) !== removeLineEndingsFromBase64String(localFileContent)) {
                const report = this.generateConflictReport(clash.path, localFileContent, remoteContent)
                let fileOp: FileOpRecord
                if (report.resolutionStrategy === "binary") {
                    fileOp = await this.handleBinaryConflict(clash.path, report.remoteContent)
                } else {
                    fileOp = await this.handleUTF8Conflict(clash.path, report.localContent, report.remoteContent)
                }
                return {path: clash.path, noDiff: false, fileOp: fileOp}
            }
            return { path: clash.path, noDiff: true }
        } else {
            // assumes remote file is deleted if sha not found in latestRemoteTreeSha.
            return { path: clash.path, noDiff: false }
        }
	}

    async resolveConflicts(
        clashedFiles: Array<ClashStatus>, latestRemoteTreeSha: Record<string, string>)
        : Promise<{noConflict: boolean, fileOpsRecord: FileOpRecord[]}> {    
            console.log("clashedFiles")
            console.log(clashedFiles)
            const fileResolutions = await Promise.all(
                clashedFiles.map(clash=>{return this.resolveFileConflict(clash, latestRemoteTreeSha[clash.path])}))
            return {
                noConflict: fileResolutions.every(res=>res.noDiff), 
                fileOpsRecord: fileResolutions.map(r => r.fileOp).filter(Boolean) as FileOpRecord[]
            }
    }
}