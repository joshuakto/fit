/**
 * Local Vault Implementation
 *
 * Implements IVault for Obsidian vault files.
 */

import { arrayBufferToBase64 } from "obsidian";
import { VaultOperations } from "./vaultOps";
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
	private vaultOps: VaultOperations;
	private baselineState: FileState;

	constructor(vaultOps: VaultOperations, baselineState: FileState = {}) {
		this.vaultOps = vaultOps;
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
	 * Compute SHA for a single file in the vault
	 */
	private async computeFileLocalSha(path: string): Promise<string> {
		const file = await this.vaultOps.getTFile(path);
		let content: string;

		if (RECOGNIZED_BINARY_EXT.includes(file.extension)) {
			content = arrayBufferToBase64(await this.vaultOps.vault.readBinary(file));
		} else {
			content = await this.vaultOps.vault.read(file);
		}

		return await this.fileSha1(path + content);
	}

	/**
	 * Compute current state of all tracked files in vault
	 */
	async computeCurrentState(): Promise<FileState> {
		const allFiles = this.vaultOps.vault.getFiles();

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
	 * Read file content for a specific path
	 * Phase 2: Will be implemented for conflict resolution
	 */
	async readFileContent(path: string): Promise<string> {
		throw new Error("LocalVault.readFileContent not yet implemented (Phase 2)");
	}

	/**
	 * Write or update a file
	 * Phase 2: Will consolidate VaultOperations.writeToLocal()
	 */
	async writeFile(path: string, content: string): Promise<FileOpRecord> {
		throw new Error("LocalVault.writeFile not yet implemented (Phase 2)");
	}

	/**
	 * Delete a file
	 * Phase 2: Will consolidate VaultOperations.deleteFromLocal()
	 */
	async deleteFile(path: string): Promise<FileOpRecord> {
		throw new Error("LocalVault.deleteFile not yet implemented (Phase 2)");
	}

	/**
	 * Apply a batch of changes (writes and deletes)
	 * Phase 2: Will consolidate VaultOperations.updateLocalFiles()
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: string}>,
		filesToDelete: Array<string>
	): Promise<FileOpRecord[]> {
		throw new Error("LocalVault.applyChanges not yet implemented (Phase 2)");
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
