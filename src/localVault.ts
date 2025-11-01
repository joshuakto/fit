/**
 * Local Vault Implementation
 *
 * Implements IVault for Obsidian vault files.
 */

import { TFile, TFolder, Vault } from "obsidian";
import { IVault, VaultError, VaultReadResult } from "./vault";
import { FileOpRecord } from "./fitTypes";
import { fitLogger } from "./logger";
import { Base64Content, FileContent } from "./contentEncoding";
import { contentToArrayBuffer, readFileContent } from "./obsidianHelpers";
import { computeSha1 } from "./utils";

/**
 * Frozen list of binary file extensions for SHA calculation consistency.
 * IMPORTANT: This list is FROZEN to ensure SHA calculations remain stable even if
 * contentEncoding.ts adds new binary extensions in the future. Adding new extensions
 * there should NOT change how we compute SHAs for existing files.
 *
 * DO NOT modify this list unless you implement a SHA migration strategy.
 */
const FROZEN_BINARY_EXT_FOR_SHA = new Set(["png", "jpg", "jpeg", "pdf"]);

/**
 * Check if a file extension is considered binary for SHA calculation purposes.
 * Uses FROZEN_BINARY_EXT_FOR_SHA to ensure SHA consistency.
 *
 * @param extension - File extension WITHOUT leading dot (e.g., "png", not ".png")
 */
function isBinaryExtensionForSha(extension: string): boolean {
	const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
	return FROZEN_BINARY_EXT_FOR_SHA.has(normalized.toLowerCase());
}

/**
 * Local vault implementation for Obsidian.
 *
 * Encapsulates all Obsidian Vault API operations including:
 * - Path filtering (hidden files starting with '.' - Vault API limitation)
 * - SHA-1 hash computation from vault file contents
 * - Change detection via baseline state comparison
 * - File read/write/delete operations
 *
 * Isolates Obsidian Vault API quirks from sync logic.
 */
export class LocalVault implements IVault {
	private vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	/**
	 * Check if path should be included in state tracking.
	 *
	 * Excludes paths that LocalVault cannot reliably read due to Obsidian Vault API limitations:
	 * - Hidden files/directories (starting with .) - Vault API can write them but cannot read them back
	 *
	 * Note: This is specifically for LocalVault storage limitations. Sync policy decisions
	 * (like excluding _fit/ from both local and remote) are handled by Fit.shouldSyncPath().
	 *
	 * Future: When hidden file support is added (using vault.adapter), this can be made
	 * configurable via settings with an opt-out for users who encounter issues.
	 */
	shouldTrackState(filePath: string): boolean {
		// Exclude hidden files/directories (any path component starting with .)
		// This is critical because Obsidian's Vault API can write hidden files
		// but cannot read them back (getAbstractFileByPath returns null)
		//
		// Obsidian vault paths always use forward slashes (even on Windows)
		const parts = filePath.split('/');
		if (parts.some(part => part.startsWith('.'))) {
			return false;
		}

		return true;
	}

	/**
	 * Batch stat operation for multiple paths.
	 * Returns the type of each path in parallel for performance.
	 *
	 * @param paths - Paths to check
	 * @returns Map of path to type ('file' | 'folder'), or null if path doesn't exist
	 */
	async statPaths(paths: string[]): Promise<Map<string, 'file' | 'folder' | null>> {
		const stats = await Promise.all(
			paths.map(async (path) => {
				const stat = await this.vault.adapter.stat(path);
				const type = stat ? stat.type : null;
				return [path, type] as const;
			})
		);
		return new Map(stats);
	}

	/**
	 * Scan vault, update latest known state, and return it
	 */
	async readFromSource(): Promise<VaultReadResult> {
		const allFiles = this.vault.getFiles();

		// Filter to only tracked paths
		const allPaths = allFiles.map(f => f.path);
		const trackedPaths = allPaths.filter(path => this.shouldTrackState(path));
		const ignoredPaths = allPaths.filter(path => !this.shouldTrackState(path));

		if (ignoredPaths.length > 0) {
			fitLogger.log('[LocalVault] Ignored paths in local scan', {
				count: ignoredPaths.length,
				paths: ignoredPaths
			});
		}

		// Compute SHAs for all tracked files
		const shaEntries = await Promise.all(
			trackedPaths.map(async (path): Promise<[string, string]> => {
				const sha = await LocalVault.fileSha1(
					path, await readFileContent(this.vault, path));
				return [path, sha];
			})
		);

		const newState = Object.fromEntries(shaEntries);

		// Log computed SHAs for provenance tracking
		fitLogger.log('[LocalVault] Computed local SHAs from filesystem', {
			source: 'vault files',
			fileCount: Object.keys(newState).length
		});

		return { state: { ...newState } };
	}

	/**
	 * Compute SHA-1 hash of file path + content
	 * (Matches GitHub's blob SHA format)
	 */
	// NOTE: Public visibility for tests.
	static fileSha1(path: string, fileContent: FileContent): Promise<string> {
		const extension = path.split('.').pop() || '';
		const contentToHash = (extension && isBinaryExtensionForSha(extension))
			// Use base64 representation for consistent hashing
			? fileContent.toBase64()
			// Preserve plaintext SHA logic for non-binary case.
			: fileContent.toPlainText();
		return computeSha1(path + contentToHash);
	}

	/**
	 * Ensure folder exists for a given file path
	 */
	private async ensureFolderExists(path: string): Promise<void> {
		// Extract folder path, return empty string if no folder path is matched (exclude the last /)
		const folderPath = path.match(/^(.*)\//)?.[1] || '';
		if (folderPath === '') {
			// At root, no parent to create
			return;
		}
		const checkExists = () => {
			const folder = this.vault.getAbstractFileByPath(folderPath);
			return !!folder;
		};
		if (!checkExists()) {
			try {
				await this.vault.createFolder(folderPath);
			} catch (error) {
				// Race condition safeguard: if folder already exists, ignore error and treat as
				// success. This can happen if a concurrent operation created the same folder.
				if (!checkExists()) {
					throw error;
				}
			}
		}
	}

	/**
	 * Read file content for a specific path
	 */
	async readFileContent(path: string): Promise<FileContent> {
		return readFileContent(this.vault, path);
	}

	/**
	 * Write or update a file
	 * @param content - File content (always Base64Content - GitHub API returns all blobs as base64)
	 * @returns Record of file operation performed
	 */
	private async writeFile(path: string, content: Base64Content): Promise<FileOpRecord> {
		try {
			const file = this.vault.getAbstractFileByPath(path);

			if (file && file instanceof TFile) {
				await this.vault.modifyBinary(file, contentToArrayBuffer(content));
				return {path, status: "changed"};
			} else if (!file) {
				await this.ensureFolderExists(path);
				await this.vault.createBinary(path, contentToArrayBuffer(content));
				return {path, status: "created"};
			}
			// File exists but is not a TFile - check if it's a folder
			if (file instanceof TFolder) {
				throw new Error(`Cannot write file to ${path}: a folder with that name already exists`);
			}
			// Unknown type - future-proof for new Obsidian abstract file types
			throw new Error(`Cannot write file to ${path}: path exists but is not a file (type: ${file.constructor.name})`);
		} catch (error) {
			// Re-throw VaultError as-is (don't double-wrap)
			if (error instanceof VaultError) {
				throw error;
			}
			const message = error instanceof Error ? error.message : `Failed to write file: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}
	}

	/**
	 * Delete a file
	 * @returns Record of file operation performed
	 */
	private async deleteFile(path: string): Promise<FileOpRecord> {
		try {
			const file = this.vault.getAbstractFileByPath(path);
			if (file && file instanceof TFile) {
				await this.vault.delete(file);
				return {path, status: "deleted"};
			}
			throw new Error(`Attempting to delete ${path} from local but not successful, file is of type ${typeof file}.`);
		} catch (error) {
			// Re-throw VaultError as-is (don't double-wrap)
			if (error instanceof VaultError) {
				throw error;
			}
			const message = error instanceof Error ? error.message : `Failed to delete file: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}
	}

	/**
	 * Apply a batch of changes (writes and deletes)
	 * Expects all content to be Base64Content (from GitHub API)
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>
	): Promise<FileOpRecord[]> {
		// Process file additions or updates
		const writeOperations = filesToWrite.map(async ({path, content}) => {
			try {
				return await this.writeFile(path, content.toBase64());
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to write to ${path}: ${message}`);
			}
		});

		// Process file deletions
		const deletionOperations = filesToDelete.map(async (path) => {
			try {
				return await this.deleteFile(path);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to delete ${path}: ${message}`);
			}
		});

		const fileOps = await Promise.all([...writeOperations, ...deletionOperations]);
		return fileOps;
	}
}
