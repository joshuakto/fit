import { Fit } from "./fit";
import { LocalChange, LocalUpdate } from "./fitTypes";
import { FileContent } from "./contentEncoding";


/**
 * Handles push operations - syncing changes from local vault to remote GitHub.
 *
 * Encapsulates the logic for:
 * - Reading local file content
 * - Preparing files for write/delete operations
 * - Delegating to remoteVault.applyChanges() for all GitHub operations
 *
 * Architecture:
 * - **Role**: Directional sync coordinator (local→remote only)
 * - **Used by**: FitSync (orchestrator)
 * - **Uses**: Fit (for vault access), RemoteGitHubVault (via Fit for GitHub operations)
 *
 * Key methods:
 * - pushChangedFilesToRemote(): Complete push operation with state updates
 *
 * Push workflow:
 * 1. Read local file content from local vault
 * 2. Prepare files to write and delete
 * 3. Call remoteVault.applyChanges() which handles all GitHub API operations
 * 4. Return updated state and operation records
 *
 * @see FitSync - The orchestrator that decides when to push
 * @see FitPull - The counterpart for pull operations
 * @see RemoteGitHubVault.applyChanges() - Handles GitHub commit operations
 */
export class FitPush {
	localSha: Record<string, string>;
	fit: Fit;


	constructor(fit: Fit) {
		this.fit = fit;
	}

	async pushChangedFilesToRemote(
		localUpdate: LocalUpdate,
	): Promise<{pushedChanges: LocalChange[], lastFetchedRemoteSha: Record<string, string>, lastFetchedCommitSha: string}|null> {
		if (localUpdate.localChanges.length === 0) {
			return null;
		}

		// Prepare files to write and delete by reading content from local vault
		const filesToWrite: Array<{path: string, content: FileContent}> = [];
		const filesToDelete: Array<string> = [];

		for (const change of localUpdate.localChanges) {
			if (change.status === 'deleted') {
				// TODO: CRITICAL SAFEGUARD - Version Migration Safety
				// Before pushing deletion, verify file is physically absent from filesystem.
				// This prevents data loss when filtering rules change between versions.
				//
				// Realistic scenario (DANGEROUS without this check):
				// - v2 implements full hidden file tracking via DataAdapter → localSha has ".gitignore"
				// - v3 reverts feature (performance regression) OR user disables "Sync hidden files" setting
				// - v3/disabled scan can't read hidden files → compareSha reports ".gitignore" as "deleted"
				// - Without check: Plugin deletes from remote → DATA LOSS
				//
				// Solution: Use vault.adapter.exists() to check raw filesystem:
				//   const physicallyExists = await this.fit.localVault.vault.adapter.exists(change.path);
				//   if (physicallyExists) {
				//     fitLogger.log('[FitPush] Skipping deletion - file exists but filtered', {
				//       path: change.path,
				//       reason: 'File present on filesystem but absent from scan (likely filtering rule change)'
				//     });
				//     continue; // Don't delete from remote
				//   }
				filesToDelete.push(change.path);
			} else {
				const content = await this.fit.localVault.readFileContent(change.path);
				filesToWrite.push({ path: change.path, content });
			}
		}

		// Use remoteVault.applyChanges() to handle all GitHub operations
		const fileOps = await this.fit.remoteVault.applyChanges(filesToWrite, filesToDelete);

		// If no operations were performed, return null
		// TODO: Should this be an error since localChanges were detected but nothing pushed?
		if (fileOps.length === 0) {
			return null;
		}

		// Get updated state after push
		const newRemoteCommitSha = await this.fit.remoteVault.getLatestCommitSha();
		const newRemoteState = await this.fit.remoteVault.readFromSource();

		// Map fileOps back to original LocalChange format for return value
		const pushedChanges = fileOps.map(op => {
			const originalChange = localUpdate.localChanges.find(c => c.path === op.path);
			return originalChange || { path: op.path, status: op.status as LocalChange['status'] };
		});

		return {
			pushedChanges,
			lastFetchedRemoteSha: newRemoteState,
			lastFetchedCommitSha: newRemoteCommitSha,
		};
	}
}
