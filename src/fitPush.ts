import { Fit, TreeNode } from "./fit";
import { LocalChange, LocalUpdate } from "./fitTypes";


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

    async createCommitFromLocalUpdate(localUpdate: LocalUpdate, remoteTree: Array<TreeNode>): Promise<{createdCommitSha: string, pushedChanges: LocalChange[]} | null> {
        const {localChanges, parentCommitSha} = localUpdate
        const pushedChanges: LocalChange[] = [];
        const treeNodes = (await Promise.all(localChanges.map(async (f, i) => {
            const node =  await this.fit.createTreeNodeFromFile(f, remoteTree)
            if (node) {
                pushedChanges.push(localChanges[i])
                return node
            }
        }))).filter(Boolean) as Array<TreeNode>
        console.log(treeNodes)
        if (treeNodes.length === 0) {
            return null
        }
        const latestRemoteCommitTreeSha = await this.fit.getCommitTreeSha(parentCommitSha)
        const createdTreeSha = await this.fit.createTree(treeNodes, latestRemoteCommitTreeSha)
        const createdCommitSha = await this.fit.createCommit(createdTreeSha, parentCommitSha)
        return {createdCommitSha, pushedChanges}
    }



    async pushChangedFilesToRemote(
        localUpdate: LocalUpdate,
        ): Promise<{pushedChanges: LocalChange[], lastFetchedRemoteSha: Record<string, string>, lastFetchedCommitSha: string}|null> {
            if (localUpdate.localChanges.length == 0) {
                // did not update ref
                return null
            }
            // const {localTreeSha} = localUpdate;
            const remoteTree = await this.fit.getTree(localUpdate.parentCommitSha)
            const createCommitResult = await this.createCommitFromLocalUpdate(localUpdate, remoteTree)
            if (!createCommitResult) {
                // did not update ref
                return null
            }
            const {createdCommitSha, pushedChanges} = createCommitResult
            const updatedRefSha = await this.fit.updateRef(createdCommitSha)
            const updatedRemoteTreeSha = await this.fit.getRemoteTreeSha(updatedRefSha)
            return {
                pushedChanges,
                lastFetchedRemoteSha: updatedRemoteTreeSha,
                lastFetchedCommitSha: createdCommitSha,
            }
    }
}