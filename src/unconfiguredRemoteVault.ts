/**
 * Placeholder remote vault used until credentials exist (or after an auth failure cleared
 * the real one). Callers are expected to check `isConfigured` / settings before syncing;
 * if one slips through, every operation rejects with a clear message instead of a
 * "cannot read properties of undefined" TypeError.
 */

import { LocalStores } from "./localStores";
import { FileContent } from "./util/contentEncoding";
import { BlobSha } from "./util/hashing";
import { ApplyChangesResult, IRemoteVault, VaultReadResult } from "./vault";

export class UnconfiguredRemoteVault implements IRemoteVault {
	readonly isConfigured = false;

	private unconfigured(operation: string): never {
		throw new Error(`Remote vault is not configured (${operation})`);
	}

	// The async methods below reject rather than throw synchronously, like a real vault would.

	async readFromSource(_ignoreCache?: boolean): Promise<VaultReadResult<"remote">> {
		return this.unconfigured('readFromSource');
	}

	async readFileContent(_path: string): Promise<FileContent> {
		return this.unconfigured('readFileContent');
	}

	async readFileBlobBySha(_sha: BlobSha): Promise<FileContent> {
		return this.unconfigured('readFileBlobBySha');
	}

	async applyChanges(
		_filesToWrite: Array<{path: string, content: FileContent}>,
		_filesToDelete: Array<string>,
		_options?: { clashPaths?: Set<string> }
	): Promise<ApplyChangesResult<"remote">> {
		return this.unconfigured('applyChanges');
	}

	async clear(): Promise<LocalStores | null> {
		return this.unconfigured('clear');
	}

	shouldTrackState(_path: string): boolean {
		return true;
	}
}
