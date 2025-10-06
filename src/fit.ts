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
 * - Maintains sync state (localSha, lastFetchedCommitSha, lastFetchedRemoteSha)
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

// TODO: Rename/reorganize this "Octokit" error handling.
type OctokitCallMethods = {
	getUser: () => Promise<{owner: string, avatarUrl: string}>
	getRepos: () => Promise<string[]>
	getRef: (ref: string) => Promise<string>
	checkRepoExists: () => Promise<boolean>
	getRemoteTreeSha: (tree_or_ref_sha: string) => Promise<{[k:string]: string}>
	createTreeNodeFromFile: ({path, status, extension}: LocalChange, remoteTree: TreeNode[]) => Promise<TreeNode|null>
};

/**
 * Interface for the Fit data access layer.
 *
 * Coordinates access to both local vault (via LocalVault) and remote repository
 * (via RemoteGitHubVault). This is the primary interface used by FitSync, FitPull,
 * and FitPush to access storage backends.
 *
 * Key characteristics:
 * - **Coordinator**: Bridges LocalVault and RemoteGitHubVault
 * - **State management**: Maintains cached SHAs for efficient change detection
 * - **Not the sync orchestrator** - that's FitSync's role
 *
 * @see Fit - The concrete implementation
 * @see FitSync - The orchestrator that uses this interface
 * @see LocalVault - Local file operations
 * @see RemoteGitHubVault - Remote GitHub operations
 */
export interface IFit extends OctokitCallMethods{
	localSha: Record<string, string>              // Cache of local file SHAs
	lastFetchedCommitSha: string | null           // Last synced commit SHA
	lastFetchedRemoteSha: Record<string, string>  // Cache of remote file SHAs
}

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
 * Maintains sync state for efficient change detection:
 * - `localSha`: Last known local file SHAs (updated after successful sync)
 * - `lastFetchedRemoteSha`: Last known remote file SHAs (from GitHub tree)
 * - `lastFetchedCommitSha`: Last synced commit SHA (for detecting remote updates)
 *
 * All GitHub-specific operations (Octokit, retry logic, API details) are delegated
 * to RemoteGitHubVault. Fit wraps these in OctokitHttpError for consistent error handling.
 *
 * @see FitSync - The high-level orchestrator that coordinates sync operations
 * @see LocalVault - Local Obsidian vault file operations
 * @see RemoteGitHubVault - Remote GitHub repository operations
 */
export class Fit implements IFit {
	localSha: Record<string, string>;
	lastFetchedCommitSha: string | null;
	lastFetchedRemoteSha: Record<string, string>;
	localVault: LocalVault;
	remoteVault: RemoteGitHubVault;


	constructor(setting: FitSettings, localStores: LocalStores, vault: Vault) {
		// Initialize localVault before loadSettings
		this.localVault = new LocalVault(vault, localStores.localSha);

		// Load settings (initializes remoteVault)
		this.loadSettings(setting);

		this.loadLocalStore(localStores);
	}

	loadSettings(setting: FitSettings) {
		// Create/recreate remoteVault with new settings (initializes Octokit internally)
		const baselineState = this.remoteVault?.getBaselineState() ?? this.lastFetchedRemoteSha ?? {};
		this.remoteVault = new RemoteGitHubVault(
			setting.pat,
			setting.owner,
			setting.repo,
			setting.branch,
			setting.deviceName,
			baselineState
		);
	}

	loadLocalStore(localStore: LocalStores) {
		this.localSha = localStore.localSha;
		this.lastFetchedCommitSha = localStore.lastFetchedCommitSha;
		this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha;
		// Update vault baselines (should always exist after construction)
		this.localVault.updateBaselineState(this.localSha);
		this.remoteVault.updateBaselineState(this.lastFetchedRemoteSha);
	}

	/**
	 * Check if a file path should be included in sync operations.
	 *
	 * Excludes paths based on sync policy:
	 * - `_fit/`: Conflict resolution directory (written locally but not synced)
	 * - `.obsidian/`: Obsidian workspace settings and plugin code
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

		// Exclude .obsidian/ directory (Obsidian workspace settings and plugins)
		if (path.startsWith(".obsidian/")) {
			return false;
		}

		return true;
	}

	async computeLocalSha(): Promise<{[k:string]:string}> {
		return await this.localVault.computeCurrentState();
	}

	async remoteUpdated(): Promise<{remoteCommitSha: string, updated: boolean}> {
		const remoteCommitSha = await this.remoteVault.getLatestCommitSha();
		return {remoteCommitSha, updated: remoteCommitSha !== this.lastFetchedCommitSha};
	}

	async getLocalChanges(currentLocalSha?: Record<string, string>): Promise<LocalChange[]> {
		if (!currentLocalSha) {
			currentLocalSha = await this.computeLocalSha();
		}
		return await this.localVault.getChanges(this.localSha);
	}

	async getRemoteChanges(remoteTreeSha: {[k: string]: string}): Promise<RemoteChange[]> {
		const remoteChanges = compareSha(remoteTreeSha, this.lastFetchedRemoteSha, "remote");
		return remoteChanges;
	}

	getClashedChanges(localChanges: LocalChange[], remoteChanges:RemoteChange[]): Array<{path: string, localStatus: LocalFileStatus, remoteStatus: RemoteChangeType}> {
		// TODO: Also treat remote changes to untrackable paths as clashes.
		// If remoteChange.path fails localVault.shouldTrackState() check:
		// - We can't read the file to know if it exists or what its content is
		// - We can't safely determine if creating/modifying it would cause conflicts
		// - Should be treated as a clash with localStatus: "untrackable" (new status)
		// - Conflict resolution should write to _fit/ since we can't verify safety
		// Example: Remote has .gitignore change, but we can't see if .gitignore exists
		// locally or what it contains, so we must treat it as a potential conflict.
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
			throw new OctokitHttpError(error.message, error.status ?? null, "getRepos");
		}
	}

	/**
	 * Check if repository exists and is accessible.
	 * Returns boolean for 404 (false), throws OctokitHttpError for other errors.
	 * Delegates to RemoteGitHubVault (which caches the result).
	 */
	async checkRepoExists(): Promise<boolean> {
		try {
			return await this.remoteVault.checkRepoExists();
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "checkRepoExists");
		}
	}

	/**
	 * Get commit SHA for a ref (e.g., "heads/main").
	 * Delegates to RemoteGitHubVault, wraps errors in OctokitHttpError.
	 */
	async getRef(ref: string): Promise<string> {
		try {
			return await this.remoteVault.getRef(ref);
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "getRef");
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
