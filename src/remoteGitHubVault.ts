/**
 * GitHub Remote Vault
 *
 * Implements IVault for GitHub repository trees.
 * Currently a stub - implementation pending.
 */

import { IVault, FileState } from "./vault";
import { RemoteChange, FileOpRecord } from "./fitTypes";

/**
 * Remote vault implementation for GitHub repositories.
 *
 * Will encapsulate GitHub-specific operations:
 * - Fetching repository tree state via Octokit
 * - Computing file SHAs from GitHub blobs
 * - Remote change detection
 * - Push/commit operations for applying changes
 *
 * Future: Create RemoteGitLabVault, RemoteGiteaVault as additional implementations.
 */
export class RemoteGitHubVault implements IVault {
	private baselineState: FileState;

	constructor(baselineState: FileState = {}) {
		this.baselineState = baselineState;
	}

	/**
	 * Compute current remote state from GitHub tree.
	 * TODO: Move getRemoteTreeSha logic here
	 */
	async computeCurrentState(): Promise<FileState> {
		// Stub: Will fetch from GitHub API in later version
		throw new Error("RemoteGitHubVault.computeCurrentState not yet implemented");
	}

	/**
	 * Detect changes between baseline and current remote state.
	 * TODO: Move getRemoteChanges logic from Fit here
	 */
	async getChanges(baselineState: FileState): Promise<RemoteChange[]> {
		// Stub: Will call computeCurrentState and compareSha in later version
		throw new Error("RemoteGitHubVault.getChanges not yet implemented");
	}

	/**
	 * Read file content for a specific path
	 * Phase 2: Will be implemented for GitHub blob fetching
	 */
	async readFileContent(path: string): Promise<string> {
		throw new Error("RemoteGitHubVault.readFileContent not yet implemented");
	}

	/**
	 * Write or update a file on remote
	 * Phase 2: Will be implemented for pushing changes to GitHub
	 */
	async writeFile(path: string, content: string): Promise<FileOpRecord> {
		throw new Error("RemoteGitHubVault.writeFile not yet implemented");
	}

	/**
	 * Delete a file from remote
	 * Phase 2: Will be implemented for pushing deletions to GitHub
	 */
	async deleteFile(path: string): Promise<FileOpRecord> {
		throw new Error("RemoteGitHubVault.deleteFile not yet implemented");
	}

	/**
	 * Apply a batch of changes to remote (creates commit and pushes)
	 * Phase 2: Will be implemented for batch push operations
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: string}>,
		filesToDelete: Array<string>
	): Promise<FileOpRecord[]> {
		throw new Error("RemoteGitHubVault.applyChanges not yet implemented");
	}

	/**
	 * Check if path should be included in state tracking.
	 *
	 * Currently returns true for all paths (tracks everything on remote).
	 * Filtering is handled on local side only.
	 *
	 * Future: Could exclude based on .gitignore patterns
	 */
	shouldTrackState(path: string): boolean {
		return true;
	}

	/**
	 * Update baseline state after successful sync
	 */
	updateBaselineState(newState: FileState): void {
		this.baselineState = newState;
	}

	/**
	 * Get current baseline state
	 */
	getBaselineState(): FileState {
		return { ...this.baselineState };
	}
}
