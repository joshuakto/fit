import { Fit, TreeNode } from "./fit";
import { LocalStores } from "main";
import { showFileOpsRecord } from "./utils";
import { LocalUpdate } from "./fitTypes";

type PrePushCheckResultType = (
    "noLocalChangesDetected" | 
    "remoteChanged" | 
    "localChangesCanBePushed"
)

export type PrePushCheckResult = (
    { status: "noLocalChangesDetected", localUpdate: null } | 
    { status: Exclude<PrePushCheckResultType, "noLocalChangesDetected">, localUpdate: LocalUpdate }
);


export interface IFitPush {
    localSha: Record<string, string>
    fit: Fit
}

export class FitPush implements IFitPush {
    localSha: Record<string, string>;
    fit: Fit
    

    constructor(fit: Fit) {
        this.fit = fit
    }


    async performPrePushChecks(): Promise<PrePushCheckResult> {
        const localTreeSha = await this.fit.computeLocalSha()
        const localChanges = await this.fit.getLocalChanges(localTreeSha)
        if (localChanges.length == 0) {
            return {status: "noLocalChangesDetected", localUpdate: null}
        }
        const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha();
        const status = (
            (latestRemoteCommitSha != this.fit.lastFetchedCommitSha) ? 
            "remoteChanged" : "localChangesCanBePushed"
        )
        return {
            status,
            localUpdate: {localChanges, localTreeSha, parentCommitSha: latestRemoteCommitSha}
        }
    }

    async createCommitFromLocalUpdate(localUpdate: LocalUpdate, remoteTree: Array<TreeNode>): Promise<string | null> {
        const {localChanges, parentCommitSha} = localUpdate
        const treeNodes = (await Promise.all(localChanges.map((f) => {
            return this.fit.createTreeNodeFromFile(f, remoteTree)
        }))).filter(Boolean) as Array<TreeNode>
        if (treeNodes.length === 0) {
            return null
        }
        const latestRemoteCommitTreeSha = await this.fit.getCommitTreeSha(parentCommitSha)
        const createdTreeSha = await this.fit.createTree(treeNodes, latestRemoteCommitTreeSha)
        const createdCommitSha = await this.fit.createCommit(createdTreeSha, parentCommitSha)
        return createdCommitSha
    }



    async pushChangedFilesToRemote(
        localUpdate: LocalUpdate,
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>,
        disableOpsNotif?: true): Promise<void> {
            const {localChanges, localTreeSha} = localUpdate;
            const remoteTree = await this.fit.getTree(localUpdate.parentCommitSha)
            const createdCommitSha = await this.createCommitFromLocalUpdate(localUpdate, remoteTree)
            if (!createdCommitSha) {return}
            const updatedRefSha = await this.fit.updateRef(createdCommitSha)
            const updatedRemoteTreeSha = await this.fit.getRemoteTreeSha(updatedRefSha)

            await saveLocalStoreCallback({
                lastFetchedRemoteSha: updatedRemoteTreeSha, 
                lastFetchedCommitSha: createdCommitSha,
                localSha: localTreeSha
            })
            if (!disableOpsNotif) {
                showFileOpsRecord([{heading: "Remote file updates:", ops: localChanges}] )
            }
    }
}