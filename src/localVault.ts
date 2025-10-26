/**
 * Local Vault Implementation
 *
 * Implements IVault for Obsidian vault files.
 */

import { TFile, Vault } from "obsidian";
import { IVault, FileState, VaultError } from "./vault";
import { FileOpRecord } from "./fitTypes";
import { fitLogger } from "./logger";
import { Base64Content, FileContent } from "./contentEncoding";
import { contentToArrayBuffer, readFileContent } from "./obsidianHelpers";

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
	 * Scan vault, update latest known state, and return it
	 */
	async readFromSource(): Promise<FileState> {
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
				return [path, await this.computeFileLocalSha(path)];
			})
		);

		const newState = Object.fromEntries(shaEntries);

		// Log computed SHAs for provenance tracking
		fitLogger.log('[LocalVault] Computed local SHAs from filesystem', {
			source: 'vault files',
			fileCount: Object.keys(newState).length
		});

		return { ...newState };
	}

	/**
	 * Compute SHA-1 hash of file path + content
	 * (Matches GitHub's blob SHA format)
	 */
	private async fileSha1(fileContent: string): Promise<string> {
		const enc = new TextEncoder();
		const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(fileContent));
		const hashArray = Array.from(new Uint8Array(hashBuf));
		const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		return hashHex;
	}

	/**
	 * Get TFile for a given path, throwing error if not found or not a file
	 */
	private async getTFile(path: string): Promise<TFile> {
		const file = this.vault.getAbstractFileByPath(path);
		if (file && file instanceof TFile) {
			return file;
		} else {
			throw new Error(`Attempting to read ${path} from local drive as TFile but not successful, file is of type ${typeof file}.`);
		}
	}

	/**
	 * Compute SHA for a single file in the vault
	 */
	private async computeFileLocalSha(path: string): Promise<string> {
		const fileContent = await readFileContent(this.vault, path);
		// Use base64 representation for consistent hashing
		const content = fileContent.toBase64();
		return await this.fileSha1(path + content);
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
	 *
	 * Returns content in format expected by RemoteGitHubVault.applyChanges():
	 * - Binary files: Base64Content (GitHub expects base64)
	 * - Text files: PlainTextContent (GitHub accepts utf-8)
	 */
	async readFileContent(pathOrSha: string): Promise<FileContent> {
		// LocalVault only uses paths (not blob SHAs)
		return readFileContent(this.vault, pathOrSha);
	}

	/**
	 * Write or update a file
	 * @param path - File path to write
	 * @param content - File content (always Base64Content - GitHub API returns all blobs as base64)
	 * @returns Record of file operation performed
	 */
	async writeFile(path: string, content: Base64Content): Promise<FileOpRecord> {
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
			throw new Error(`${path} writeFile operation unsuccessful, vault abstractFile on ${path} is of type ${typeof file}`);
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
	 * @param path - File path to delete
	 * @returns Record of file operation performed
	 */
	async deleteFile(path: string): Promise<FileOpRecord> {
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
