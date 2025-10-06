/**
 * Vault Interfaces
 *
 * Core abstractions for vault operations (read/write) across different storage backends.
 * A "vault" represents a complete collection of synced files, whether stored locally
 * (Obsidian vault) or remotely (GitHub repository, GitLab, etc.).
 */

import { LocalChange, RemoteChange, FileOpRecord } from "./fitTypes";

/**
 * Represents a snapshot of file states at a point in time.
 * Maps file paths to their content hashes (SHA-1).
 */
export type FileState = Record<string, string>;

/**
 * Generic change representation (can be local or remote)
 */
export type StateChange = LocalChange | RemoteChange;

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
 * const localVault = new LocalVault(obsidianVault, cachedState);
 * const remoteVault = new RemoteGitHubVault(octokit, cachedRemoteState);
 *
 * // Detect changes without knowing storage backend details
 * const localChanges = await localVault.getChanges(lastSyncState);
 * const remoteChanges = await remoteVault.getChanges(lastSyncState);
 *
 * // Apply changes without knowing storage backend details
 * await localVault.writeFile('file.md', 'content');
 * await remoteVault.deleteFile('old-file.md');
 * ```
 */
export interface IVault {
	// ===== Read Operations (State Detection) =====

	/**
	 * Compute the current state of all tracked files
	 * @returns Map of file paths to their SHA-1 content hashes
	 */
	computeCurrentState(): Promise<FileState>;

	/**
	 * Detect changes between baseline state and current state
	 * @param baselineState - Previous state to compare against
	 * @returns List of changes (added, modified, deleted files)
	 */
	getChanges(baselineState: FileState): Promise<StateChange[]>;

	/**
	 * Read file content for a specific path or SHA
	 *
	 * For LocalVault: path is a file path in the vault
	 * For RemoteGitHubVault: path is a blob SHA (GitHub stores content by hash)
	 *
	 * @param path - File path (LocalVault) or blob SHA (RemoteGitHubVault)
	 * @returns File content (base64 encoded for binary files)
	 */
	readFileContent(path: string): Promise<string>;

	// ===== Write Operations (Applying Changes) =====

	/**
	 * Write or update a file
	 * @param path - File path to write
	 * @param content - File content (base64 encoded for binary files)
	 * @returns Record of file operation performed
	 */
	writeFile(path: string, content: string): Promise<FileOpRecord>;

	/**
	 * Delete a file
	 * @param path - File path to delete
	 * @returns Record of file operation performed
	 */
	deleteFile(path: string): Promise<FileOpRecord>;

	/**
	 * Apply a batch of changes (writes and deletes)
	 *
	 * For LocalVault: Applies changes to Obsidian vault files
	 * For RemoteGitHubVault: Creates a single commit with all changes
	 *
	 * @param filesToWrite - Files to write or update
	 * @param filesToDelete - Files to delete
	 * @returns Records of all file operations performed
	 */
	applyChanges(
		filesToWrite: Array<{path: string, content: string}>,
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
