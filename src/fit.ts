/**
 * Sync Coordinator and State Manager
 *
 * This module coordinates access to both local vault (LocalVault) and remote repository
 * (RemoteGitHubVault), and maintains sync state (cached SHAs for change detection).
 */

import { LocalStores } from "@/localStores";
import { FitSettings, ObsidianSyncRules } from "@/fitSettings";
import { FileChange, FileClash, FileStates, LocalClashState, compareFileStates } from "./util/changeTracking";
import { Vault } from "obsidian";
import { LocalVault } from "./localVault";
import { RemoteGitHubVault } from "./remoteGitHubVault";
import { fitLogger } from "./logger";
import { CommitSha } from "./util/hashing";

// .obsidian/ paths excluded from sync regardless of obsidianSyncRules.
// workspace files are device-specific.
export const OBSIDIAN_ALWAYS_EXCLUDED = new Set([
	".obsidian/workspace.json",
	".obsidian/workspace-mobile.json",
]);

// Paths blocked in v1 because safe sync requires v2 capabilities:
// - community/core plugins: need array-merge to avoid install conflicts across devices
// - plugins/fit/data.json: contains PAT — needs field-level exclusion before it can safely sync
export const OBSIDIAN_NEEDS_MERGE = new Set([
	".obsidian/community-plugins.json",
	".obsidian/core-plugins.json",
	".obsidian/plugins/fit/data.json",
]);

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
	localShas: FileStates;                  // Canonical git blob SHA cache (primary, v2)
	localSha: FileStates;                   // Legacy path+content SHA cache (migration source)
	lastFetchedCommitSha: CommitSha | null; // Last synced commit SHA
	lastFetchedRemoteShas: FileStates;      // Canonical remote SHA cache
	unpushedFiles: FileStates;              // Files skipped due to API size limit (422)
	pendingClashes: string[];               // Paths with unresolved _fit/ copies
	obsidianSyncRules: ObsidianSyncRules;
	localVault: LocalVault;                 // Local vault (tracks local file state)
	remoteVault: RemoteGitHubVault;
	private ownDataPath: string | null = null; // e.g. ".obsidian/plugins/fit/data.json"


	constructor(setting: FitSettings, localStores: LocalStores, vault: Vault, pluginDir?: string) {
		this.localVault = new LocalVault(vault);
		if (pluginDir) this.ownDataPath = `${pluginDir}/data.json`;
		this.loadSettings(setting);  // NOTE: creates this.remoteVault
		this.loadLocalStore(localStores);
	}

	loadSettings(setting: FitSettings) {
		// Recreate remoteVault with new settings (preserves existing state)
		// This is called when user changes settings in UI
		// TODO: Use DI to pass the right impl from FitSync caller.

		// Apply local vault settings unconditionally (don't require PAT)
		this.obsidianSyncRules = setting.obsidianSyncRules ?? {};
		this.localVault.configure({
			syncHiddenFiles: setting.syncHiddenFiles,
			obsidianSyncRules: this.obsidianSyncRules,
		});

		// Skip if no PAT - no API access possible
		if (!setting.pat) {
			return;
		}

		// If owner is invalid but we have a valid remoteVault, preserve it
		// This prevents overwriting a valid config with an incomplete one
		// Example: User types "alice" → onChange fires 5 times with partial values ("a", "al", ...)
		// Note: clearRemoteVault() should be called on auth failure to allow re-creation
		// TODO: Shouldn't this be validated when SAVING settings vs LOADING?
		if (!setting.owner && this.remoteVault) {
			return;
		}

		this.remoteVault = new RemoteGitHubVault(
			setting.pat,
			setting.owner,
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
		this.localShas = localStore.localShas ?? {};
		this.localSha = localStore.localSha ?? {};
		this.lastFetchedCommitSha = localStore.lastFetchedCommitSha;
		this.lastFetchedRemoteShas = localStore.lastFetchedRemoteShas;
		this.unpushedFiles = localStore.unpushedFiles ?? {};
		this.pendingClashes = localStore.pendingClashes ?? [];

		const localCount = Object.keys(this.localShas).length;
		const legacyCount = Object.keys(this.localSha).length;
		const remoteCount = Object.keys(this.lastFetchedRemoteShas).length;
		const warnings: string[] = [];

		if (localCount === 0 && legacyCount === 0 && remoteCount === 0 && this.lastFetchedCommitSha) {
			warnings.push('Empty SHA caches but commit SHA exists - possible cache corruption or first sync after data loss');
		}
		if (localCount === 0 && legacyCount === 0 && remoteCount > 0) {
			warnings.push('Local SHA cache empty but remote cache has files - may incorrectly pull files as "new" that were deleted locally');
		}

		fitLogger.log('.. 📦 [Cache] Loaded SHA caches from storage', {
			source: 'plugin data.json',
			localShasCount: localCount,
			legacyShaCount: legacyCount,
			remoteShasCount: remoteCount,
			lastCommit: this.lastFetchedCommitSha,
			...(warnings.length > 0 && { warnings })
		});
	}

	/**
	 * Check if a file path should be included in sync operations.
	 *
	 * Excludes paths based on sync policy:
	 * - `_fit/`: Conflict resolution directory (written locally but not synced)
	 * - `.obsidian/`: Excluded by default; individual paths may be opted in via obsidianSyncRules
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

		if (path.startsWith(".obsidian/")) {
			// Always-excluded regardless of user rules
			if (OBSIDIAN_ALWAYS_EXCLUDED.has(path)) return false;
			if (OBSIDIAN_NEEDS_MERGE.has(path)) return false;
			// Block own data.json dynamically — covers symlinked/alternate install dirs
			if (this.ownDataPath && path === this.ownDataPath) return false;

			const rule = this.obsidianSyncRules?.[path];
			if (!rule) return false;

			const strategy = rule.sync ?? "replace";
			if (strategy !== "replace") {
				fitLogger.log(`[Sync] WARNING: Unknown strategy "${strategy}" for ${path} — skipping (not supported in this version)`);
				return false;
			}
			return true;
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

		// Clean up orphaned legacy entries for files no longer present locally.
		for (const path of Object.keys(this.localSha)) {
			if (currentState[path] === undefined) {
				delete this.localSha[path];
			}
		}

		// Batch migration on first sync after upgrade: promote all legacy SHAs to canonical.
		// Re-reads each legacy file to compute the legacy SHA and verify content is unchanged,
		// then adopts the canonical SHA from readFromSource() as the new baseline.
		// This doubles file reads for legacy files on this sync. Canonical-only and neither cases
		// are handled normally by compareFileStates below.
		const pendingLegacyPaths = Object.keys(this.localSha).filter(p => currentState[p] !== undefined);
		if (pendingLegacyPaths.length > 0) {
			const rePromotingPaths = pendingLegacyPaths.filter(p => this.localShas[p] !== undefined);
			if (rePromotingPaths.length > 0) {
				fitLogger.log('[Fit] Discarding stale canonical SHAs for re-promotion', {
					count: rePromotingPaths.length,
					reason: 'localSha and localShas both present — old client wrote legacy SHAs after a downgrade; treating localSha as more recent and re-running migration'
				});
			}
			fitLogger.log('[Fit] Promoting legacy SHAs to canonical', { count: pendingLegacyPaths.length });
			for (const path of pendingLegacyPaths) {
				try {
					const content = await this.localVault.readFileContent(path);
					const legacySha = await LocalVault.fileLegacySha1(path, content);
					if (legacySha === this.localSha[path]) {
						// Content unchanged since legacy sync — adopt canonical SHA as baseline.
						this.localShas[path] = currentState[path];
					}
					// On mismatch: file changed, no canonical baseline set → appears as ADDED below.
				} catch {
					// File unreadable — leave unresolved, re-tries next sync.
				}
				delete this.localSha[path];
			}
		}

		// Filter both states to paths that are trackable AND syncable (#169).
		// shouldTrackState: LocalVault can read the file (always true when syncHiddenFiles=true).
		// shouldSyncPath: sync policy allows pushing (filters _fit/, .obsidian/, etc.).
		// Both required — protected paths like .obsidian/ are readable but never pushed,
		// and would appear as phantom ADDED changes without this combined filter.
		const isSyncCandidate = (path: string) =>
			this.localVault.shouldTrackState(path) && this.shouldSyncPath(path);

		const trackableLocalShas: FileStates = {};
		for (const [path, sha] of Object.entries(this.localShas)) {
			if (isSyncCandidate(path)) {
				trackableLocalShas[path] = sha;
			}
		}
		const trackableCurrentState: FileStates = {};
		for (const [path, sha] of Object.entries(currentState)) {
			if (isSyncCandidate(path)) {
				trackableCurrentState[path] = sha;
			}
		}
		const changes = compareFileStates(trackableCurrentState, trackableLocalShas);
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
		const changes = compareFileStates(state, this.lastFetchedRemoteShas);

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
}
