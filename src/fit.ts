/**
 * Sync Coordinator and State Manager
 *
 * This module coordinates access to both local vault (LocalVault) and remote repository
 * (RemoteGitHubVault), and maintains sync state (cached SHAs for change detection).
 */

import { LocalStores } from "@/localStores";
import { FitSettings, ObsidianSyncRules } from "@/fitSettings";
import { FitAttributesFile, FITATTRIBUTES_PATH, parseFitAttributes } from "@/fitAttributes";
import { FileChange, FileStates, compareFileStates } from "./util/changeTracking";
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
	protectedPathShas: FileStates;          // Remote SHAs for paths excluded by shouldSyncPath (dedup cache)
	obsidianSyncRules: ObsidianSyncRules;
	fitAttributes: FitAttributesFile = {};  // Parsed from local .fitattributes.json; refreshed each sync
	// Set when the last .fitattributes.json parse attempt failed; null when it parsed fine or
	// the file doesn't exist. FitSync surfaces this as a visible Notice — a malformed file
	// would otherwise fail silently, which is worse than noisy for a config file this load-bearing.
	fitAttributesWarning: string | null = null;
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
		this.protectedPathShas = localStore.protectedPathShas ?? {};

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
	 * `.obsidian/` paths seen this sync (local and/or remote) that are actively syncing
	 * because of a legacy obsidianSyncRules opt-in — for a once-per-sync watermark log, not
	 * a per-call one, since shouldSyncPath itself is called many times per path per sync.
	 * obsidianSyncRules is retired entirely in the git-driven tracking replacement, so this
	 * (and its only caller) disappears with it — no future cleanup needed here.
	 */
	activeObsidianSyncRulePaths(currentLocalState: FileStates, remoteTreeSha: FileStates): string[] {
		const candidates = new Set<string>();
		for (const path of Object.keys(currentLocalState)) {
			if (path.startsWith(".obsidian/")) candidates.add(path);
		}
		for (const path of Object.keys(remoteTreeSha)) {
			if (path.startsWith(".obsidian/")) candidates.add(path);
		}
		return [...candidates].filter(path => this.shouldSyncPath(path)).sort();
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

	/**
	 * Reads and parses local .fitattributes.json content (already known to exist), updating
	 * this.fitAttributes and this.fitAttributesWarning. Shared by the eager (reconcile) and
	 * lazy (getLocalChanges) refresh paths below.
	 */
	private async readAndApplyFitAttributes(): Promise<void> {
		try {
			const fitAttributesContent = await this.localVault.readFileContent(FITATTRIBUTES_PATH);
			const parsed = parseFitAttributes(fitAttributesContent.toPlainText());
			if (parsed.ok) {
				this.setFitAttributes(parsed.value);
				this.fitAttributesWarning = null;
			} else {
				const message = `.fitattributes.json is malformed (${parsed.error}) — will affect correctness of sync in future versions`;
				fitLogger.log(`[Fit] ${message}`);
				this.setFitAttributes({});
				this.fitAttributesWarning = message;
			}
		} catch (err) {
			// Exists but unreadable (I/O error, permission issue, etc.) — distinct from a
			// parse failure above, but equally worth surfacing rather than silently treating
			// as unconfigured: a config file this load-bearing shouldn't fail silently.
			const reason = err instanceof Error ? err.message : String(err);
			const message = `.fitattributes.json exists but could not be read (${reason}) — will affect correctness of sync in future versions`;
			fitLogger.log(`[Fit] ${message}`);
			this.setFitAttributes({});
			this.fitAttributesWarning = message;
		}
	}

	/** Replaces the parsed .fitattributes.json content. */
	setFitAttributes(attributes: FitAttributesFile): void {
		this.fitAttributes = attributes;
	}

	/**
	 * Eagerly re-parses local .fitattributes.json content into this.fitAttributes, ahead of
	 * the normal per-sync local scan. Only worth calling when there's something that could
	 * actually be reconciled this sync (see FitSync's pre-sync reconcile block) — a local
	 * edit to .fitattributes.json needs to be visible the SAME sync it was made, not delayed
	 * a sync like the general lazy update in getLocalChanges (which only updates fitAttributes
	 * from data the scan already touched). Checks existence via statPaths first so a call
	 * where the file doesn't exist touches nothing further.
	 */
	async refreshFitAttributesForReconcile(): Promise<void> {
		const stats = await this.localVault.statPaths([FITATTRIBUTES_PATH]);
		if (stats.get(FITATTRIBUTES_PATH) !== 'file') {
			this.setFitAttributes({});
			this.fitAttributesWarning = null;
			return;
		}
		await this.readAndApplyFitAttributes();
	}

	async getLocalChanges(): Promise<{changes: FileChange[], state: FileStates}> {
		fitLogger.log('.. 💾 [LocalVault] Scanning files...');
		const readResult = await this.localVault.readFromSource();
		const currentState = readResult.state;

		// Re-parse .fitattributes.json content from this scan's own knowledge of whether the
		// file exists — never a separate stat/read probe, so a sync where it simply doesn't
		// exist touches it zero times. This runs before shouldSyncPath filtering below, so a
		// local edit made just before running sync already gates this sync's own local
		// push/pull decisions — no lag. The pre-sync reconcile block (FitSync) is a separate
		// consumer of this.fitAttributes with its own eager refresh
		// (refreshFitAttributesForReconcile), specifically so a tracking-transition decision
		// doesn't have to wait on this lazy path either.
		if (currentState[FITATTRIBUTES_PATH] !== undefined) {
			await this.readAndApplyFitAttributes();
		} else {
			this.setFitAttributes({});
			this.fitAttributesWarning = null;
		}

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
}
