import { Fit } from "./fit";
import { TreeNode } from "./remoteGitHubVault";
import { LocalChange, LocalUpdate } from "./fitTypes";


/**
 * Interface for push operations (local→remote sync).
 *
 * @see FitPush - The concrete implementation
 */
export interface IFitPush {
	localSha: Record<string, string>
	fit: Fit
}

/**
 * Handles push operations - syncing changes from local vault to remote GitHub.
 *
 * Encapsulates the logic for:
 * - Creating GitHub blobs from local file content
 * - Building Git trees from local changes
 * - Creating commits on the remote repository
 * - Updating the remote branch reference
 *
 * Architecture:
 * - **Role**: Directional sync coordinator (local→remote only)
 * - **Used by**: FitSync (orchestrator)
 * - **Uses**: Fit (for GitHub API and local vault access)
 *
 * Key methods:
 * - pushChangedFilesToRemote(): Complete push operation with state updates
 * - createCommitFromLocalUpdate(): Builds commit from local changes
 *
 * Git commit workflow:
 * 1. Read local file content from vault
 * 2. Create blobs on GitHub for each changed file
 * 3. Build tree with new blobs + unchanged files from parent
 * 4. Create commit pointing to new tree
 * 5. Update branch ref to point to new commit
 *
 * @see FitSync - The orchestrator that decides when to push
 * @see FitPull - The counterpart for pull operations
 * @see Fit - Provides GitHub API access and local vault operations
 */
export class FitPush implements IFitPush {
	localSha: Record<string, string>;
	fit: Fit;


	constructor(fit: Fit) {
		this.fit = fit;
	}

	// TODO: MAJOR REFACTORING - Replace entire push workflow with remoteVault.applyChanges()
	// Current code: Manually creates blobs/trees/commits using low-level Fit methods
	// Target: Use remoteVault.applyChanges(filesToWrite, filesToDelete) which handles:
	//   - Reading local file content via localVault.readFileContent()
	//   - Creating blobs with correct encoding (binary vs text)
	//   - Building tree with all changes in one commit
	//   - Creating commit and updating ref
	// This will eliminate ~50 lines of GitHub API orchestration code
	async createCommitFromLocalUpdate(localUpdate: LocalUpdate, remoteTree: Array<TreeNode>): Promise<{createdCommitSha: string, pushedChanges: LocalChange[]} | null> {
		const {localChanges, parentCommitSha} = localUpdate;
		const pushedChanges: LocalChange[] = [];
		const treeNodes = (await Promise.all(localChanges.map(async (f, i) => {
			const node =  await this.fit.createTreeNodeFromFile(f, remoteTree);
			if (node) {
				pushedChanges.push(localChanges[i]);
				return node;
			}
		}))).filter(Boolean) as Array<TreeNode>;
		console.log(treeNodes);
		if (treeNodes.length === 0) {
			return null;
		}
		const latestRemoteCommitTreeSha = await this.fit.remoteVault.getCommitTreeSha(parentCommitSha);
		const createdTreeSha = await this.fit.remoteVault.createTree(treeNodes, latestRemoteCommitTreeSha);
		const createdCommitSha = await this.fit.remoteVault.createCommit(createdTreeSha, parentCommitSha);
		return {createdCommitSha, pushedChanges};
	}



	async pushChangedFilesToRemote(
		localUpdate: LocalUpdate,
	): Promise<{pushedChanges: LocalChange[], lastFetchedRemoteSha: Record<string, string>, lastFetchedCommitSha: string}|null> {
		if (localUpdate.localChanges.length == 0) {
			// did not update ref
			return null;
		}
		// const {localTreeSha} = localUpdate;
		const remoteTree = await this.fit.remoteVault.getTree(localUpdate.parentCommitSha);
		const createCommitResult = await this.createCommitFromLocalUpdate(localUpdate, remoteTree);
		if (!createCommitResult) {
			// did not update ref
			return null;
		}
		const {createdCommitSha, pushedChanges} = createCommitResult;
		const updatedRefSha = await this.fit.remoteVault.updateRef(createdCommitSha);
		const updatedRemoteTreeSha = await this.fit.getRemoteTreeSha(updatedRefSha);
		return {
			pushedChanges,
			lastFetchedRemoteSha: updatedRemoteTreeSha,
			lastFetchedCommitSha: createdCommitSha,
		};
	}
}
