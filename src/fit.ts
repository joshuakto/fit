/**
 * Sync Coordinator and State Manager
 *
 * This module coordinates access to both local vault (LocalVault) and remote repository
 * (RemoteGitHubVault), and maintains sync state (cached SHAs for change detection).
 *
 * Architecture Role:
 * - **Coordinator**: Bridges LocalVault and RemoteGitHubVault
 * - **State Manager**: Maintains cached file SHAs for efficient change detection
 * - **Used by**: FitSync (orchestrator), FitPull (pull operations), FitPush (push operations)
 * - **Uses**: LocalVault (local file operations), RemoteGitHubVault (GitHub API operations)
 *
 * Key Responsibilities:
 * - Delegates local operations to LocalVault
 * - Delegates remote operations to RemoteGitHubVault
 * - Maintains sync state (lastFetchedCommitSha)
 * - Change detection helpers (comparing local vs remote state)
 * - Wraps errors in OctokitHttpError for consistent error handling
 *
 * @see LocalVault - Local Obsidian vault file operations
 * @see RemoteGitHubVault - Remote GitHub repository operations (including Octokit, retry logic, etc.)
 */

import { LocalStores, FitSettings } from "main";
import { RECOGNIZED_BINARY_EXT, compareSha } from "./utils";
import { LocalChange, LocalFileStatus, RemoteChange, RemoteChangeType } from "./fitTypes";
import { Vault } from "obsidian";
import { SyncError } from "./syncResult";
import { LocalVault } from "./localVault";
import { RemoteGitHubVault, TreeNode } from "./remoteGitHubVault";
import { FileState } from "./vault";

// TODO: Rename/reorganize this "Octokit" error handling.
type OctokitCallMethods = {
	getUser: () => Promise<{owner: string, avatarUrl: string}>
	getRepos: () => Promise<string[]>
	getBranches: () => Promise<string[]>
	getRemoteTreeSha: (tree_or_ref_sha: string) => Promise<{[k:string]: string}>
	createTreeNodeFromFile: ({path, status, extension}: LocalChange, remoteTree: TreeNode[]) => Promise<TreeNode|null>
};

/**
 * HTTP error from GitHub API operations.
 *
 * Thrown by Fit methods when RemoteGitHubVault operations fail.
 * Contains the HTTP status code (or null for network errors) and the source
 * method name for debugging.
 *
 * @property status - HTTP status code, or null if network error (couldn't reach GitHub)
 * @property source - Name of the method that failed (matches IFit method names)
 *
 * @see FitSync.sync() - Catches and categorizes these errors for user-friendly messages
 */
export class OctokitHttpError extends Error {
	status: number | null;
	source: keyof OctokitCallMethods;

	constructor(message: string, status: number | null, source: keyof OctokitCallMethods) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.source = source;
	}
}

/**
 * Coordinator for local vault and remote repository access with sync state management.
 *
 * Bridges two vault implementations:
 * - **LocalVault**: Obsidian vault file operations
 * - **RemoteGitHubVault**: GitHub repository operations
 *
 * Maintains sync state for efficient change detection
 *
 * All GitHub-specific operations (Octokit, retry logic, API details) are delegated
 * to RemoteGitHubVault. Fit wraps these in OctokitHttpError for consistent error handling.
 *
 * @see FitSync - The high-level orchestrator that coordinates sync operations
 * @see LocalVault - Local Obsidian vault file operations
 * @see RemoteGitHubVault - Remote GitHub repository operations
 */
export class Fit implements OctokitCallMethods {
	localSha: Record<string, string>;              // Cache of local file SHAs
	lastFetchedCommitSha: string | null;           // Last synced commit SHA
	lastFetchedRemoteSha: Record<string, string>;  // Cache of remote file SHAs
	localVault: LocalVault;                        // Local vault (tracks local file state)
	remoteVault: RemoteGitHubVault;


	constructor(setting: FitSettings, localStores: LocalStores, vault: Vault) {
		this.localVault = new LocalVault(vault);
		this.loadSettings(setting);  // NOTE: creates this.remoteVault
		this.loadLocalStore(localStores);
	}

	loadSettings(setting: FitSettings) {
		// Recreate remoteVault with new settings (preserves existing state)
		// This is called when user changes settings in UI
		this.remoteVault = new RemoteGitHubVault(
			setting.pat,
			setting.owner,
			setting.repo,
			setting.branch,
			setting.deviceName
		);
	}

	loadLocalStore(localStore: LocalStores) {
		this.localSha = localStore.localSha;
		this.lastFetchedCommitSha = localStore.lastFetchedCommitSha;
		this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha;
	}

	/**
	 * Check if a file path should be included in sync operations.
	 *
	 * Excludes paths based on sync policy:
	 * - `_fit/`: Conflict resolution directory (written locally but not synced)
	 *
	 * Future: Will also respect .gitignore patterns when implemented.
	 *
	 * Note: This is sync policy, not a storage limitation. Both LocalVault and
	 * RemoteGitHubVault can read/write these paths - we choose not to sync them.
	 *
	 * @param path - File path to check
	 * @returns true if path should be included in sync
	 */
	shouldSyncPath(path: string): boolean {
		// Exclude _fit/ directory (conflict resolution area)
		if (path.startsWith("_fit/")) {
			return false;
		}

		return true;
	}

	async remoteUpdated(): Promise<{remoteCommitSha: string, updated: boolean}> {
		const remoteCommitSha = await this.remoteVault.getLatestCommitSha();
		return {remoteCommitSha, updated: remoteCommitSha !== this.lastFetchedCommitSha};
	}

	async getLocalChanges(): Promise<{changes: LocalChange[], state: FileState}> {
		const currentState = await this.localVault.readFromSource();
		const changes = compareSha(currentState, this.localSha, "local");
		return { changes, state: currentState };
	}

	/**
	 * Get remote changes since last sync.
	 *
	 * @param commitSha - Commit SHA to read from (should be obtained from remoteUpdated())
	 * @returns Remote changes and current state
	 */
	async getRemoteChanges(commitSha: string): Promise<{changes: RemoteChange[], state: FileState}> {
		const currentState = await this.remoteVault.readFromSourceAtCommit(commitSha);
		const changes = compareSha(currentState, this.lastFetchedRemoteSha, "remote");
		return { changes, state: currentState };
	}

	getClashedChanges(localChanges: LocalChange[], remoteChanges:RemoteChange[]): Array<{path: string, localStatus: LocalFileStatus, remoteStatus: RemoteChangeType}> {
		// TODO: Also treat remote changes to untrackable paths as potential clashes.
		// Example: Remote has .gitignore change, but if .gitignore exists locally it's not
		// indexed, so we don't know if it has local changes.
		const localChangePaths = localChanges.map(c=>c.path);
		const remoteChangePaths = remoteChanges.map(c=>c.path);
		const clashedFiles = localChangePaths.map(
			(path, localIndex) => {
				const remoteIndex = remoteChangePaths.indexOf(path);
				if (remoteIndex !== -1) {
					return {path, localIndex, remoteIndex};
				}
				return null;
			}).filter(Boolean) as Array<{path: string, localIndex: number, remoteIndex:number}>;
		return clashedFiles.map(
			({path, localIndex, remoteIndex}) => {
				return {
					path,
					localStatus: localChanges[localIndex].status,
					remoteStatus: remoteChanges[remoteIndex].status
				};
			});
	}

	/**
	 * Get authenticated user info from GitHub.
	 * Delegates to RemoteGitHubVault, wraps errors in OctokitHttpError.
	 */
	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		try {
			return await this.remoteVault.getUser();
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "getUser");
		}
	}

	/**
	 * List repositories owned by authenticated user.
	 * Delegates to RemoteGitHubVault, wraps errors in OctokitHttpError.
	 */
	async getRepos(): Promise<string[]> {
		try {
			return await this.remoteVault.getRepos();
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "getRepos");
		}
	}

	/**
	 * List branches in repository.
	 * Delegates to RemoteGitHubVault, wraps errors in OctokitHttpError.
	 */
	async getBranches(): Promise<string[]> {
		try {
			return await this.remoteVault.getBranches();
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "getBranches");
		}
	}

	/**
	 * Get remote file state as SHA map (path -> content SHA).
	 * Accepts either tree SHA or ref/commit SHA. Filters paths based on sync policy.
	 * Returns format compatible with local store cache.
	 * Delegates to RemoteGitHubVault.
	 */
	async getRemoteTreeSha(tree_or_ref_sha: string): Promise<{[k:string]: string}> {
		return await this.remoteVault.getRemoteTreeSha(
			tree_or_ref_sha,
			(path) => this.shouldSyncPath(path)
		);
	}

	/**
	 * Create a tree node for a changed file.
	 * Reads file content from LocalVault and creates blob on GitHub via RemoteGitHubVault.
	 * Skips if file unchanged on remote (same blob SHA already exists).
	 *
	 * @param change - Local file change (path, status, extension)
	 * @param remoteTree - Current remote tree nodes (for optimization)
	 * @returns TreeNode to include in commit, or null if no change needed
	 */
	async createTreeNodeFromFile({path, status, extension}: LocalChange, remoteTree: Array<TreeNode>): Promise<TreeNode|null> {
		// Read file content from local vault (null for deletions)
		const content = status === "deleted"
			? null
			: await this.localVault.readFileContent(path);

		// Determine encoding
		const encoding = (extension && RECOGNIZED_BINARY_EXT.includes(extension)) ? "base64" : "utf-8";

		// Delegate to RemoteGitHubVault to create tree node
		return await this.remoteVault.createTreeNodeFromContent(path, content, remoteTree, encoding);
	}

	/**
	 * Generate user-friendly error message from structured sync error
	 */
	getSyncErrorMessage(syncError: SyncError): string {
		// Return user-friendly message based on error type
		switch (syncError.type) {
			case 'network':
				return `${syncError.detailMessage}. Please check your internet connection.`;

			case 'remote_access':
				return `${syncError.detailMessage}. Check your GitHub personal access token.`;

			case 'remote_not_found':
				return `${syncError.detailMessage}. Check your repo and branch settings.`;

			case 'filesystem': {
				return `File system error: ${syncError.detailMessage}`;
			}

			case 'unknown':
			case 'api_error':
			default:
				return syncError.detailMessage;
		}
	}

}
