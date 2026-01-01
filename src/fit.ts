/**
 * Sync Coordinator and State Manager
 *
 * This module coordinates access to both local vault (LocalVault) and remote repository
 * (RemoteGitHubVault), and maintains sync state (cached SHAs for change detection).
 */

import { LocalStores, FitSettings } from "@main";
import { FileChange, FileClash, FileStates, LocalClashState, compareFileStates } from "./util/changeTracking";
import { Vault } from "obsidian";
import { LocalVault } from "./localVault";
import { RemoteGitHubVault } from "./remoteGitHubVault";
import { fitLogger } from "./logger";
import { CommitSha } from "./util/hashing";

/**
 * Coordinator for local vault and remote repository access with sync state management.
 *
 * Bridges two vault implementations:
 * - **LocalVault**: Obsidian vault file operations
 * - **RemoteGitHubVault**: GitHub repository operations
 *
 * Maintains sync state for efficient change detection.
 * All vault operations throw VaultError on failure (network, auth, remote not found).
 *
 * @see FitSync - The high-level orchestrator that coordinates sync operations
 * @see LocalVault - Local Obsidian vault file operations
 * @see RemoteGitHubVault - Remote GitHub repository operations
 */
export class Fit {
	// TODO: Rename these for clarity: localFileShas, remoteCommitSha, remoteFileShas
	localSha: FileStates;                   // Cache of local file SHAs
	lastFetchedCommitSha: CommitSha | null; // Last synced commit SHA
	lastFetchedRemoteSha: FileStates;       // Cache of remote file SHAs
	localVault: LocalVault;                 // Local vault (tracks local file state)
	remoteVault: RemoteGitHubVault;


	constructor(setting: FitSettings, localStores: LocalStores, vault: Vault) {
		this.localVault = new LocalVault(vault);
		this.loadSettings(setting);  // NOTE: creates this.remoteVault
		this.loadLocalStore(localStores);
	}

	loadSettings(setting: FitSettings) {
		// Recreate remoteVault with new settings (preserves existing state)
		// This is called when user changes settings in UI
		// TODO: Use DI to pass the right impl from FitSync caller.
		// Use repoOwner for API calls (may differ from authenticated user for contributor repos)
		// Trim and validate owner to handle empty/whitespace-only strings
		// Note: Trim repoOwner BEFORE the || check to handle whitespace-only strings correctly
		const rawOwner = (setting.repoOwner?.trim() || setting.owner || '').trim();

		// Skip if no PAT - no API access possible
		if (!setting.pat) {
			return;
		}

		// If owner is invalid but we have a valid remoteVault, preserve it
		// This prevents overwriting a valid config with an incomplete one
		// Note: clearRemoteVault() should be called on auth failure to allow re-creation
		if (!rawOwner && this.remoteVault) {
			return;
		}

		this.remoteVault = new RemoteGitHubVault(
			setting.pat,
			rawOwner,
			setting.repo,
			setting.branch,
			setting.deviceName
		);
	}

	/**
	 * Clear the remoteVault instance.
	 * Call this on authentication failure to allow re-creation on next attempt.
	 */
	clearRemoteVault() {
		this.remoteVault = undefined as unknown as RemoteGitHubVault;
	}

	loadLocalStore(localStore: LocalStores) {
		this.localSha = localStore.localSha;
		this.lastFetchedCommitSha = localStore.lastFetchedCommitSha;
		this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha;
		// Detect potentially corrupted/suspicious cache states
		const localCount = Object.keys(this.localSha).length;
		const remoteCount = Object.keys(this.lastFetchedRemoteSha).length;
		const warnings: string[] = [];

		// Warn if caches are empty but commit SHA exists (possible cache corruption)
		if (localCount === 0 && remoteCount === 0 && this.lastFetchedCommitSha) {
			warnings.push('Empty SHA caches but commit SHA exists - possible cache corruption or first sync after data loss');
		}

		// Warn if local cache is empty but remote cache has files (asymmetric state)
		if (localCount === 0 && remoteCount > 0) {
			warnings.push('Local SHA cache empty but remote cache has files - may incorrectly pull files as "new" that were deleted locally');
		}

		// Log SHA cache provenance for debugging
		fitLogger.log('.. 📦 [Cache] Loaded SHA caches from storage', {
			source: 'plugin data.json',
			localShaCount: localCount,
			remoteShaCount: remoteCount,
			lastCommit: this.lastFetchedCommitSha,
			...(warnings.length > 0 && { warnings })
		});
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
	 * TODO: Rename to isProtectedPath() and invert logic (return true for protected paths)
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

	/**
	 * Filter a FileState to include only paths that should be synced.
	 * Used when updating LocalStores to ensure excluded paths (like _fit/) aren't tracked.
	 *
	 * @param state - Complete file state from vault
	 * @returns Filtered state containing only synced paths
	 */
	filterSyncedState(state: FileStates): FileStates {
		const filtered: FileStates = {};
		for (const [path, sha] of Object.entries(state)) {
			if (this.shouldSyncPath(path)) {
				filtered[path] = sha;
			}
		}
		return filtered;
	}

	async getLocalChanges(): Promise<{changes: FileChange[], state: FileStates}> {
		fitLogger.log('.. 💾 [LocalVault] Scanning files...');
		const readResult = await this.localVault.readFromSource();
		const currentState = readResult.state;
		// Filter both states to only trackable files for comparison (#169)
		// This prevents hidden files (stored for baseline checking) from appearing as spurious changes
		// Filter cached state to exclude hidden files
		const trackableLocalSha: FileStates = {};
		for (const [path, sha] of Object.entries(this.localSha)) {
			if (this.localVault.shouldTrackState(path)) {
				trackableLocalSha[path] = sha;
			}
		}
		// Filter current state to exclude hidden files (defensive against bugs)
		const trackableCurrentState: FileStates = {};
		for (const [path, sha] of Object.entries(currentState)) {
			if (this.localVault.shouldTrackState(path)) {
				trackableCurrentState[path] = sha;
			}
		}
		const changes = compareFileStates(trackableCurrentState, trackableLocalSha);
		return { changes, state: currentState };
	}

	/**
	 * Get remote changes since last sync.
	 *
	 * Uses RemoteGitHubVault's internal caching - vault will only fetch from GitHub
	 * if the latest commit SHA differs from its cached commit SHA.
	 *
	 * @returns Remote changes, current state, and the commit SHA of the fetched state
	 */
	async getRemoteChanges(): Promise<{changes: FileChange[], state: FileStates, commitSha: CommitSha}> {
		fitLogger.log('.. ☁️ [RemoteVault] Fetching from GitHub...');
		const { state, commitSha } = await this.remoteVault.readFromSource();
		if (!commitSha) {
			throw new Error("Expected RemoteGitHubVault to provide commitSha");
		}
		const changes = compareFileStates(state, this.lastFetchedRemoteSha);

		// Diagnostic logging for tracking remote cache state
		if (changes.length > 0) {
			fitLogger.log('[Fit] Remote changes detected', {
				ADDED: changes.filter(c => c.type === 'ADDED').length,
				MODIFIED: changes.filter(c => c.type === 'MODIFIED').length,
				REMOVED: changes.filter(c => c.type === 'REMOVED').length,
				total: changes.length
			});
		}

		return { changes, state, commitSha };
	}

	getClashedChanges(localChanges: FileChange[], remoteChanges:FileChange[]): Array<FileClash> {
		const clashes: Array<FileClash> = [];

		// Step 1: Filter out remote changes to untracked/unsynced paths and treat as clashes.
		const trackedRemoteChanges: FileChange[] = [];

		for (const remoteChange of remoteChanges) {
			if (this.shouldSyncPath(remoteChange.path) && this.localVault.shouldTrackState(remoteChange.path)) {
				trackedRemoteChanges.push(remoteChange);
			} else {
				// Determine if blocked by sync policy or untracked
				const localState: LocalClashState = !this.shouldSyncPath(remoteChange.path)
					? 'protected'
					: 'untracked';
				clashes.push({
					path: remoteChange.path,
					localState,
					remoteOp: remoteChange.type
				});
			}
		}

		// Step 2: Find tracked paths that changed on both sides
		const localChangesByPath = new Map(localChanges.map(lc => [lc.path, lc.type]));

		for (const remoteChange of trackedRemoteChanges) {
			const localState = localChangesByPath.get(remoteChange.path);
			if (localState !== undefined) {
				// Both sides changed this tracked path
				clashes.push({
					path: remoteChange.path,
					localState,
					remoteOp: remoteChange.type
				});
			}
		}

		return clashes;
	}

	/**
	 * Get authenticated user info from GitHub.
	 * Delegates to RemoteGitHubVault (throws VaultError on failure).
	 */
	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		return await this.remoteVault.getUser();
	}

	/**
	 * List repositories owned by authenticated user.
	 * Delegates to RemoteGitHubVault (throws VaultError on failure).
	 */
	async getRepos(): Promise<string[]> {
		return await this.remoteVault.getRepos();
	}

	/**
	 * List branches in repository.
	 * Delegates to RemoteGitHubVault (throws VaultError on failure).
	 */
	async getBranches(): Promise<string[]> {
		return await this.remoteVault.getBranches();
	}
}
