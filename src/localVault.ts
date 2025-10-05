/**
 * Local Vault Implementation
 *
 * Implements IVault for Obsidian vault files.
 */

import { arrayBufferToBase64, base64ToArrayBuffer, TFile, Vault } from "obsidian";
import { IVault, FileState } from "./vault";
import { LocalChange, FileOpRecord } from "./fitTypes";
import { RECOGNIZED_BINARY_EXT, compareSha } from "./utils";

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
	private baselineState: FileState;

	constructor(vault: Vault, baselineState: FileState = {}) {
		this.vault = vault;
		this.baselineState = baselineState;
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
		const file = await this.getTFile(path);
		let content: string;

		if (RECOGNIZED_BINARY_EXT.includes(file.extension)) {
			content = arrayBufferToBase64(await this.vault.readBinary(file));
		} else {
			content = await this.vault.read(file);
		}

		return await this.fileSha1(path + content);
	}

	/**
	 * Compute current state of all tracked files in vault
	 */
	async computeCurrentState(): Promise<FileState> {
		const allFiles = this.vault.getFiles();

		// Filter to only tracked paths
		const trackedPaths = allFiles
			.map(f => f.path)
			.filter(path => this.shouldTrackState(path));

		// Compute SHAs for all tracked files
		const shaEntries = await Promise.all(
			trackedPaths.map(async (path): Promise<[string, string]> => {
				return [path, await this.computeFileLocalSha(path)];
			})
		);

		return Object.fromEntries(shaEntries);
	}

	/**
	 * Detect changes between baseline and current vault state
	 */
	async getChanges(baselineState: FileState): Promise<LocalChange[]> {
		const currentState = await this.computeCurrentState();
		const changes = compareSha(currentState, baselineState, "local");
		return changes;
	}

	/**
	 * Ensure folder exists for a given file path
	 */
	private async ensureFolderExists(path: string): Promise<void> {
		// Extract folder path, return empty string if no folder path is matched (exclude the last /)
		const folderPath = path.match(/^(.*)\//)?.[1] || '';
		if (folderPath != "") {
			const folder = this.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				await this.vault.createFolder(folderPath);
			}
		}
	}

	/**
	 * Read file content for a specific path
	 */
	async readFileContent(path: string): Promise<string> {
		const file = await this.getTFile(path);

		if (RECOGNIZED_BINARY_EXT.includes(file.extension)) {
			return arrayBufferToBase64(await this.vault.readBinary(file));
		} else {
			return await this.vault.read(file);
		}
	}

	/**
	 * Write or update a file
	 */
	async writeFile(path: string, content: string): Promise<FileOpRecord> {
		const file = this.vault.getAbstractFileByPath(path);
		// TODO: add capability for creating folder from remote
		// TODO: Should this check extension and handle text case instead of assuming binary?
		if (file && file instanceof TFile) {
			await this.vault.modifyBinary(file, base64ToArrayBuffer(content));
			return {path, status: "changed"};
		} else if (!file) {
			// TODO: Await this to avoid race condition
			this.ensureFolderExists(path);
			await this.vault.createBinary(path, base64ToArrayBuffer(content));
			return {path, status: "created"};
		}
		throw new Error(`${path} writeFile operation unsuccessful, vault abstractFile on ${path} is of type ${typeof file}`);
	}

	/**
	 * Delete a file
	 */
	async deleteFile(path: string): Promise<FileOpRecord> {
		const file = this.vault.getAbstractFileByPath(path);
		if (file && file instanceof TFile) {
			await this.vault.delete(file);
			return {path, status: "deleted"};
		}
		throw new Error(`Attempting to delete ${path} from local but not successful, file is of type ${typeof file}.`);
	}

	/**
	 * Apply a batch of changes (writes and deletes)
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: string}>,
		filesToDelete: Array<string>
	): Promise<FileOpRecord[]> {
		// Process file additions or updates
		const writeOperations = filesToWrite.map(async ({path, content}) => {
			return await this.writeFile(path, content);
		});

		// Process file deletions
		const deletionOperations = filesToDelete.map(async (path) => {
			return await this.deleteFile(path);
		});

		const fileOps = await Promise.all([...writeOperations, ...deletionOperations]);
		return fileOps;
	}

	/**
	 * Create a copy of a file in a specified directory (typically _fit/)
	 */
	async createCopyInDir(path: string, copyDir = "_fit"): Promise<void> {
		const file = this.vault.getAbstractFileByPath(path);
		if (file && file instanceof TFile) {
			const copy = await this.vault.readBinary(file);
			const copyPath = `${copyDir}/${path}`;
			// TODO: Await this to avoid race condition
			this.ensureFolderExists(copyPath);
			const copyFile = this.vault.getAbstractFileByPath(copyPath);
			if (copyFile && copyFile instanceof TFile) {
				await this.vault.modifyBinary(copyFile, copy);
			} else if (!copyFile) {
				await this.vault.createBinary(copyPath, copy);
			} else {
				// TODO: This was probably supposed to await the delete.
				this.vault.delete(copyFile, true); // TODO add warning to let user know files in _fit will be overwritten
				await this.vault.createBinary(copyPath, copy);
			}
		} else {
			throw new Error(`Attempting to create copy of ${path} from local drive as TFile but not successful, file is of type ${typeof file}.`);
		}
	}

	/**
	 * Update the baseline state (typically after successful sync)
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
