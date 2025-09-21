import { arrayBufferToBase64 } from "obsidian"
import { Fit } from "./fit"
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteChange, RemoteUpdate } from "./fitTypes"
import { RECOGNIZED_BINARY_EXT, extractExtension, removeLineEndingsFromBase64String } from "./utils"
import { FitPull } from "./fitPull"
import { FitPush } from "./fitPush"
import { VaultOperations } from "./vaultOps"
import { LocalStores } from "main"
import FitNotice from "./fitNotice"
import { SyncResult, SyncErrors } from "./syncResult"
import { OctokitHttpError } from "./fit"

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
    fitPull: FitPull
    fitPush: FitPush
    vaultOps: VaultOperations
    saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>
    

    constructor(fit: Fit, vaultOps: VaultOperations, saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>) {
        this.fit = fit
        this.fitPull = new FitPull(fit)
        this.fitPush = new FitPush(fit)
        this.vaultOps = vaultOps
        this.saveLocalStoreCallback = saveLocalStoreCallback
    }

    async performPreSyncChecks(): Promise<PreSyncCheckResult> {
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
        : Promise<{noConflict: boolean, unresolvedFiles: ClashStatus[], fileOpsRecord: FileOpRecord[]}> {    
            const fileResolutions = await Promise.all(
                clashedFiles.map(clash=>{return this.resolveFileConflict(clash, latestRemoteTreeSha[clash.path])}))
            const unresolvedFiles = fileResolutions.map((res, i)=> {
                if (!res.noDiff) {
                    return clashedFiles[i]
                }
                return null
            }).filter(Boolean) as Array<ClashStatus>
            return {
                noConflict: fileResolutions.every(res=>res.noDiff), 
                unresolvedFiles,
                fileOpsRecord: fileResolutions.map(r => r.fileOp).filter(Boolean) as FileOpRecord[]
            }
    }

    async syncCompatibleChanges(
        localUpdate: LocalUpdate, 
        remoteUpdate: RemoteUpdate, 
        syncNotice: FitNotice): Promise<{localOps: LocalChange[], remoteOps: FileOpRecord[]}> {
			const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
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
			const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)
			await this.saveLocalStoreCallback({
				lastFetchedRemoteSha: latestRemoteTreeSha, 
				lastFetchedCommitSha: latestCommitSha,
				localSha: await this.fit.computeLocalSha()
			})
			syncNotice.setMessage("Sync successful")
            return {localOps: localFileOpsRecord, remoteOps: pushedChanges}
    }


    async syncWithConflicts(
        localChanges: LocalChange[],
        remoteUpdate: RemoteUpdate, 
        syncNotice: FitNotice) : Promise<{unresolvedFiles: ClashStatus[], localOps: LocalChange[], remoteOps: LocalChange[]} | null> {
        const {latestRemoteCommitSha, clashedFiles, remoteTreeSha: latestRemoteTreeSha} = remoteUpdate
			const {noConflict, unresolvedFiles, fileOpsRecord} = await this.resolveConflicts(clashedFiles, latestRemoteTreeSha)
            let localChangesToPush: Array<LocalChange>;
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
            const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(remoteChangesToWrite)
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
            const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)
            await this.saveLocalStoreCallback({
                lastFetchedRemoteSha, 
                lastFetchedCommitSha,
                localSha: await this.fit.computeLocalSha()
            })
            const ops = localFileOpsRecord.concat(fileOpsRecord)
            if (unresolvedFiles.length === 0) {
                syncNotice.setMessage(`Sync successful`)
            } else if (unresolvedFiles.some(f => f.remoteStatus !== "REMOVED")) {
                // let user knows remote file changes have been written to _fit if non-deletion change on remote clashed with local changes
                syncNotice.setMessage(`Synced with remote, unresolved conflicts written to _fit`)
            } else {
                syncNotice.setMessage(`Synced with remote, ignored remote deletion of locally changed files`)
            }
            return {unresolvedFiles, localOps: ops, remoteOps: pushedChanges}
    }

	async sync(syncNotice: FitNotice): Promise<SyncResult> {
		try {
			syncNotice.setMessage("Performing pre sync checks.")
			const preSyncCheckResult = await this.performPreSyncChecks();

			// convert to switch statement later on for better maintainability
			if (preSyncCheckResult.status === "inSync") {
				syncNotice.setMessage("Sync successful")
				return { success: true, operations: [], conflicts: [] }
			}

			if (preSyncCheckResult.status === "onlyRemoteCommitShaChanged") {
				const { latestRemoteCommitSha } = preSyncCheckResult.remoteUpdate
				await this.saveLocalStoreCallback({ lastFetchedCommitSha: latestRemoteCommitSha })
				syncNotice.setMessage("Sync successful")
				return { success: true, operations: [], conflicts: [] }
			}

			const remoteUpdate = preSyncCheckResult.remoteUpdate
			if (preSyncCheckResult.status === "onlyRemoteChanged") {
				let fileOpsRecord: FileOpRecord[]
				try {
					fileOpsRecord = await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Filesystem operation failed'
					console.error(`Sync operation failed - File system error: ${errorMessage}`)
					return { success: false, error: SyncErrors.filesystem(errorMessage) }
			}
				syncNotice.setMessage("Sync successful")
				return { success: true, operations: [{ heading: "Local file updates:", ops: fileOpsRecord }], conflicts: [] }
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
				await this.saveLocalStoreCallback({
					localSha: localTreeSha,
					lastFetchedRemoteSha: pushResult.lastFetchedRemoteSha,
					lastFetchedCommitSha: pushResult.lastFetchedCommitSha
				})
				return { success: true, operations: [{ heading: "Local file updates:", ops: pushResult.pushedChanges }], conflicts: [] }
			}
			console.error("Sync operation failed - Failed to push local changes")
			return { success: false, error: SyncErrors.unknown("Failed to push local changes") }
		}

		// do both pull and push (orders of execution different from pullRemoteToLocal and
		// pushChangedFilesToRemote to make this more transaction like, i.e. maintain original
		// state if the transaction failed) If you have ideas on how to make this more transaction-like,
		// please open an issue on the fit repo
		if (preSyncCheckResult.status === "localAndRemoteChangesCompatible") {
			const {localOps, remoteOps} = await this.syncCompatibleChanges(
				localUpdate, remoteUpdate, syncNotice)
			return {
				success: true,
				operations: [
					{ heading: "Local file updates:", ops: localOps },
					{ heading: "Remote file updates:", ops: remoteOps },
				],
				conflicts: []
			}
		}

		if (preSyncCheckResult.status === "localAndRemoteChangesClashed") {
			const conflictResolutionResult = await this.syncWithConflicts(
				localUpdate.localChanges, remoteUpdate, syncNotice)
			if (conflictResolutionResult) {
				const {unresolvedFiles, localOps, remoteOps} = conflictResolutionResult
                        return {
                            success: true,
                            operations: [
                                {heading: "Local file updates:", ops: localOps},
                                {heading: "Remote file updates:", ops: remoteOps},
                            ],
                            conflicts: unresolvedFiles
                        }
			}
		}

            console.error("Sync operation failed - Unknown sync status")
            return { success: false, error: SyncErrors.unknown("Unknown sync status") }
        } catch (error) {
            // Map specific error types to appropriate SyncError
            if (error instanceof OctokitHttpError) {
                if (error.status === 401) {
                    console.error(`Sync operation failed - Authentication failed: ${error.message}`)
                    return { success: false, error: SyncErrors.auth(error.message) }
                }
                if (error.status === 404) {
                    if (error.source === 'getRef') {
                        console.error(`Sync operation failed - Branch not found: ${error.message}`)
                        return { success: false, error: SyncErrors.repoNotFound(`Branch not found. Check repository name and branch name in settings.`) }
                    } else {
                        console.error(`Sync operation failed - Repository not found: ${error.message}`)
                        return { success: false, error: SyncErrors.repoNotFound(`Repository not found. Check repository name and access permissions.`) }
                    }
                }
                // Other HTTP errors from GitHub API
                console.error(`Sync operation failed - GitHub API error (${error.status}): ${error.message}`)
                return { success: false, error: SyncErrors.network(`GitHub API error (${error.status}): ${error.message}`) }
            }

            if (error instanceof Error) {
                if (error.message.includes('network') || error.message.includes('fetch')) {
                    console.error(`Sync operation failed - Network error: ${error.message}`)
                    return { success: false, error: SyncErrors.network(error.message) }
                }
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
            console.error(`Sync operation failed - Unknown error: ${errorMessage}`)
            return { success: false, error: SyncErrors.unknown(errorMessage) }
        }
    }
}
