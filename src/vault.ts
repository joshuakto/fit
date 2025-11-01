/**
 * Vault Interfaces
 *
 * Core abstractions for vault operations (read/write) across different storage backends.
 * A "vault" represents a complete collection of synced files, whether stored locally
 * (Obsidian vault) or remotely (GitHub repository, GitLab, etc.).
 */

import { LocalChange, RemoteChange, FileOpRecord } from "./fitTypes";
import { FileContent } from "./contentEncoding";

/**
 * Represents a snapshot of file states at a point in time.
 * Maps file paths to their content hashes (SHA-1).
 */
export type FileState = Record<string, string>;

/**
 * Result of reading vault state, including vault-specific metadata.
 *
 * For RemoteGitHubVault: Includes the commit SHA of the fetched state
 * For LocalVault: May be extended in future for other metadata
 */
export type VaultReadResult = {
	state: FileState;
	commitSha?: string; // Present for RemoteGitHubVault (GitHub commit SHA)
};

/**
 * Generic change representation (can be local or remote)
 */
export type StateChange = LocalChange | RemoteChange;

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
		public details?: { originalError?: unknown }
	) {
		super(message);
		this.name = 'VaultError';
	}

	// Generic factory helper
	private static create(type: VaultErrorType) {
		return (message: string, details?: { originalError?: unknown }) =>
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
 * @example
 * ```typescript
 * // Initialize vaults with cached state from persisted storage
 * const localVault = new LocalVault(obsidianVault, cachedLocalState);
 * const remoteVault = new RemoteGitHubVault(octokit, cachedRemoteState);
 *
 * // Detect changes (typically in pre-sync checks)
 * const currentLocal = await localVault.readFromSource();
 * const localChanges = compareSha(currentLocal, baselineState, "local");
 *
 * // Apply changes during sync
 * await localVault.applyChanges(
 *   [{path: 'new-file.md', content: 'content'}],  // files to write
 *   ['old-file.md']                                // files to delete
 * );
 *
 * // Update vault cache after sync (scan and update internal state atomically)
 * const newLocalState = await localVault.readFromSource();
 * // Save to persistent cache
 * await saveToCache({localSha: newLocalState});
 * ```
 */
export interface IVault {
	// ===== Read Operations =====

	/**
	 * Scan source and return the current scanned state with vault-specific metadata.
	 *
	 * For LocalVault: Scans all files in Obsidian vault
	 * For RemoteGitHubVault: Fetches tree from GitHub API and includes commit SHA
	 *
	 * @returns The scanned state and vault-specific metadata
	 */
	readFromSource(): Promise<VaultReadResult>;

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
	 *
	 * For RemoteGitHubVault: Creates a single commit with all changes
	 *   - Uses FileContent's existing encoding (plaintext or base64)
	 *   - Tells GitHub API the appropriate encoding
	 *
	 * @param filesToWrite - Files to write or update with their content
	 * @param filesToDelete - Files to delete
	 * @returns Records of all file operations performed
	 */
	applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>
	): Promise<FileOpRecord[]>;

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
