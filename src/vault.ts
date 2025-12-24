/**
 * Vault Interfaces
 *
 * Core abstractions for vault operations (read/write) across different storage backends.
 * A "vault" represents a complete collection of synced files, whether stored locally
 * (Obsidian vault) or remotely (GitHub repository, GitLab, etc.).
 */

import { FileChange, FileStates } from "./util/changeTracking";
import { FileContent } from "./util/contentEncoding";
import { CommitSha, TreeSha } from "./util/hashing";

/** Discriminated return types for readFromSource() based on vault category */
type VaultReadResultMap = {
	/** Local vault result - just the state */
	"local": {
		state: FileStates;
	};
	/** Remote vault result - includes commit SHA and tree SHA */
	"remote": {
		state: FileStates;
		commitSha: CommitSha;
		treeSha: TreeSha;
	};
};

/**
 * Result of reading vault state, including vault-specific metadata.
 *
 * For RemoteGitHubVault: Includes the commit SHA of the fetched state
 * For LocalVault: May be extended in future for other metadata
 */
export type VaultReadResult<T extends VaultCategory = VaultCategory> = VaultReadResultMap[T];

/**
 * Vault category: local filesystem vs remote git hosting
 */
export type VaultCategory = "local" | "remote";

/** Map vault category to its specific ApplyChangesResult type (exhaustiveness-checked) */
type ApplyChangesResultMap = {
	/** Local vault result - includes SHA computation promise */
	"local": {
		/** Promise for file SHAs (computed from in-memory content during writes).
		 * Await when ready to update local state - allows parallelization on mobile. */
		writtenStates: Promise<FileStates>;
	};
	/** Remote vault result - includes commit metadata and new state */
	"remote": {
		/** New commit SHA created on remote */
		commitSha: CommitSha;
		/** New tree SHA created on remote */
		treeSha: TreeSha;
		/** FileStates computed from the new tree (for cache updates) */
		newState: FileStates;
	};
};

export type ApplyChangesResult<T extends VaultCategory> =
	{
		changes: FileChange[];
		/** Optional user-facing warning message to display after sync */
		userWarning?: string;
	} & ApplyChangesResultMap[T];

// ===== Vault Error Types =====

export type VaultErrorType =
  | 'network'           // General networking problem (request failure without HTTP status)
  | 'remote_not_found'  // Remote repository, branch, or access issues (404)
  | 'authentication'    // Authentication/authorization failures (401, 403)
  | 'filesystem';       // Local file system errors

/**
 * Vault-layer error with categorized error types.
 * Use static factory methods (VaultError.network(), VaultError.remoteNotFound(), etc.) to construct.
 *
 * Message guidelines:
 * - Should actually describe the error with specifics from the error context
 * - Avoid redundant repetition of type name (e.g., not "Network error: network failed")
 * - Include useful info from the original error when available
 */
export class VaultError extends Error {
	constructor(
		public type: VaultErrorType,
		message: string,
		public details?: {
			originalError?: unknown;
			failedPaths?: string[];
			errors?: Array<{ path: string; error: unknown }>;
		}
	) {
		super(message);
		this.name = 'VaultError';
	}

	// Generic factory helper
	private static create(type: VaultErrorType) {
		return (message: string, details?: {
			originalError?: unknown;
			failedPaths?: string[];
			errors?: Array<{ path: string; error: unknown }>;
		}) =>
			new VaultError(type, message, details);
	}

	/** Network/connectivity error (no HTTP status, no response, or fetch failure) */
	static network = VaultError.create('network');

	/** Remote resource not found (404 - repository, branch, etc.) */
	static remoteNotFound = VaultError.create('remote_not_found');

	/** Authentication/authorization failure (401, 403) */
	static authentication = VaultError.create('authentication');

	/** Local file system error (EACCES, ENOENT, etc.) */
	static filesystem = VaultError.create('filesystem');
}

/**
 * Interface for vault implementations (local or remote).
 *
 * Abstracts storage backend details, allowing FitSync to operate on any pair
 * of vaults (local/remote) without knowing implementation specifics.
 *
 * Implementations handle both read operations (state detection) and write operations
 * (applying changes), making this a complete abstraction for file storage.
 *
 * @typeParam T - Vault category ("local" | "remote") determining return type of applyChanges
 *
 * @example
 * ```typescript
 * // Initialize vaults with cached state from persisted storage
 * const localVault = new LocalVault(obsidianVault, cachedLocalState);
 * const remoteVault = new RemoteGitHubVault(octokit, cachedRemoteState);
 *
 * // Detect changes (typically in pre-sync checks)
 * const currentLocal = await localVault.readFromSource();
 * const localChanges = compareFileStates(currentLocal, baselineState);
 *
 * // Apply changes during sync - return type inferred from vault type
 * const result = await localVault.applyChanges(
 *   [{path: 'new-file.md', content: 'content'}],  // files to write
 *   ['old-file.md']                                // files to delete
 * );
 * // result.writtenStates is available (ApplyChangesResult<"local">)
 *
 * // Update vault cache after sync (scan and update internal state atomically)
 * const newLocalState = await localVault.readFromSource();
 * // Save to persistent cache
 * await saveToCache({localSha: newLocalState});
 * ```
 */
export interface IVault<T extends VaultCategory> {
	// ===== Read Operations =====

	/**
	 * Scan source and return the current scanned state with vault-specific metadata.
	 *
	 * For LocalVault: Scans all files in Obsidian vault
	 * For RemoteGitHubVault: Fetches tree from GitHub API and includes commit SHA
	 *
	 * @returns The scanned state and vault-specific metadata
	 */
	readFromSource(): Promise<VaultReadResult<T>>;

	/**
	 * Read file content for a specific path
	 *
	 * For RemoteGitHubVault, returns content as of last readFromSource() for performance (does NOT force fresh remote fetch).
	 *
	 * Callers can use FileContent's toBase64() or toPlainText() helpers to get the content
	 * in the desired format without worrying about the source encoding.
	 *
	 * @param path - File path
	 * @returns File content with runtime encoding tag
	 */
	readFileContent(path: string): Promise<FileContent>;

	// ===== Write Operations (Applying Changes) =====

	/**
	 * Apply a batch of changes (writes and deletes)
	 *
	 * For LocalVault: Applies changes to Obsidian vault files
	 *   - Converts FileContent to base64 and writes via Obsidian API
	 *   - Returns writtenStates for efficient state updates
	 *
	 * For RemoteGitHubVault: Creates a single commit with all changes
	 *   - Uses FileContent's existing encoding (plaintext or base64)
	 *   - Returns new commitSha and treeSha
	 *
	 * @param filesToWrite - Files to write or update with their content
	 * @param filesToDelete - Files to delete
	 * @returns Operations performed and vault-specific metadata (type determined by T)
	 */
	applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>
	): Promise<ApplyChangesResult<T>>;

	// ===== Metadata =====

	/**
	 * Check if path should be included in state tracking.
	 *
	 * Returns false for paths that CANNOT be read reliably due to storage backend
	 * limitations (e.g., LocalVault cannot read hidden files via Obsidian Vault API).
	 *
	 * This is separate from sync policy decisions (handled by caller):
	 * - shouldTrackState: "Can this vault implementation reliably read this path?"
	 * - Fit.shouldSyncPath: "Should we sync this path between local and remote?"
	 *
	 * Example: _fit/ directory
	 * - LocalVault.shouldTrackState('_fit/file.md') → true (can read it)
	 * - RemoteGitHubVault.shouldTrackState('_fit/file.md') → true (can read it)
	 * - Fit.shouldSyncPath('_fit/file.md') → false (shouldn't sync it)
	 *
	 * @param path - File path to check
	 * @returns true if this vault implementation can reliably track the path
	 */
	shouldTrackState(path: string): boolean;
}
