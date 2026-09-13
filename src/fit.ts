/**
 * Sync Coordinator and State Manager
 *
 * This module coordinates access to both local vault (LocalVault) and remote repository
 * (RemoteGitHubVault), and maintains sync state (cached SHAs for change detection).
 */

import { LocalStores } from "@/localStores";
import { FitSettings } from "@/fitSettings";
import { FitAttributesFile, FITATTRIBUTES_PATH, parseFitAttributes } from "@/fitAttributes";
import { FileChange, FileStates, compareFileStates } from "./util/changeTracking";
import { Vault } from "obsidian";
import { LocalVault } from "./localVault";
import { RemoteGitHubVault } from "./remoteGitHubVault";
import { fitLogger } from "./logger";
import { CommitSha } from "./util/hashing";
import { isHardDenylistedObsidianPath } from "./util/protectedPaths";

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
	pendingUntrackedPaths: string[];        // .obsidian/ paths remote-removed while locally unedited — see LocalStores
	fitAttributes: FitAttributesFile = {};  // Parsed from local .fitattributes.json; refreshed each sync
	// Set when the last .fitattributes.json parse attempt failed; null when it parsed fine or
	// the file doesn't exist. FitSync surfaces this as a visible Notice — a malformed file
	// silently means "no .obsidian/ path syncs", which is worse than noisy to leave log-only.
	fitAttributesWarning: string | null = null;
	localVault: LocalVault;                 // Local vault (tracks local file state)
	remoteVault: RemoteGitHubVault;
	private ownDataPath: string | null = null; // e.g. ".obsidian/plugins/fit/data.json"
	// Same-sync-only, unpersisted: paths reconciled from untracked→tracked earlier in the
	// current sync. Needed because the reconcile block's own "local absent" branch clears
	// lastFetchedRemoteShas[path] (to force correct ADDED-detection downstream), which would
	// otherwise make shouldSyncPath flip back to untracked for the rest of this same sync,
	// undoing the reconciliation. Recomputed fresh every sync — not a cross-sync opt-in.
	private trackedForCurrentSync: Set<string> = new Set();


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
		this.localVault.configure({
			syncHiddenFiles: setting.syncHiddenFiles,
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
		this.pendingUntrackedPaths = localStore.pendingUntrackedPaths ?? [];

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
	 * - `.obsidian/`: Excluded unless git-tracked (content exists in the remote git tree
	 *   or has an established local baseline) AND format-eligible (`.fitattributes.json`
	 *   declares `format: "text"` for the path). See docs/sync-logic.md § Protected Paths.
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
			// The trigger is git, not FIT: tracked purely because content exists (or has an
			// established baseline) — never because of a local toggle of any kind.
			const isTracked =
				path in this.localShas ||
				path in this.lastFetchedRemoteShas ||
				this.trackedForCurrentSync.has(path);
			if (!isTracked) return false;

			return this.isEligibleForTracking(path);
		}

		return true;
	}

	/**
	 * Everything shouldSyncPath checks for a `.obsidian/` path *except* whether it's
	 * currently tracked — i.e. "would this path sync once/if tracked?". Split out so the
	 * pre-sync reconcile block (FitSync) can ask this about a path that's about to become
	 * tracked without a chicken-and-egg dependency on shouldSyncPath's own tracked-check.
	 */
	isEligibleForTracking(path: string): boolean {
		if (this.isHardDenylistedPath(path)) return false;

		// Format:"json" is reserved (field-level masking, not built yet); an unconfigured
		// tracked path is detection-only regardless of JSON-shape.
		return this.fitAttributes[path]?.format === "text";
	}

	/**
	 * A `.obsidian/` path that is currently actively syncing (tracked + format-eligible).
	 * For these paths, a remote REMOVED is ambiguous between "the file was actually
	 * deleted" and "someone removed it from the repo to stop syncing it" — the latter is
	 * the documented way to untrack a git-mask path (see docs/sync-logic.md § Protected
	 * Paths). resolveAllChanges uses this to route such removals to pendingUntrackedPaths
	 * instead of auto-deleting the local file. Non-`.obsidian/` paths are always false —
	 * ordinary tracked files have no such ambiguity, remote deletion just means deletion.
	 */
	isGitMaskTrackedPath(path: string): boolean {
		return path.startsWith(".obsidian/") && this.shouldSyncPath(path);
	}

	/** Path-level hard denylist — see src/util/protectedPaths.ts for the "why". */
	isHardDenylistedPath(path: string): boolean {
		return isHardDenylistedObsidianPath(path, this.ownDataPath);
	}

	/** Replaces the parsed .fitattributes.json content used by shouldSyncPath's format gate. */
	setFitAttributes(attributes: FitAttributesFile): void {
		this.fitAttributes = attributes;
	}

	/**
	 * Dry-run classification of `.obsidian/` paths found this sync (local scan and/or
	 * remote tree) that are NOT actively syncing, plus the one bucket that is — purely
	 * for diagnostic logging (FitSync logs the result, see docs/sync-logic.md § Protected
	 * Paths). No extra I/O: derived entirely from this sync's already-fetched local/remote
	 * state. "untracked" means no remote git content — the trigger this whole feature runs
	 * on — not any other kind of exclusion.
	 */
	classifyObsidianPathsForLog(
		currentLocalState: FileStates,
		remoteState: FileStates
	): { trackedTextMode: string[]; hardDenylisted: string[]; trackedUnconfigured: string[]; untracked: string[] } {
		const candidates = new Set<string>();
		for (const path of Object.keys(currentLocalState)) {
			if (path.startsWith(".obsidian/")) candidates.add(path);
		}
		for (const path of Object.keys(remoteState)) {
			if (path.startsWith(".obsidian/")) candidates.add(path);
		}

		const trackedTextMode: string[] = [];
		const hardDenylisted: string[] = [];
		const trackedUnconfigured: string[] = [];
		const untracked: string[] = [];

		for (const path of [...candidates].sort()) {
			if (this.isHardDenylistedPath(path)) {
				hardDenylisted.push(path);
			} else if (path in remoteState) {
				if (this.fitAttributes[path]?.format === "text") {
					trackedTextMode.push(path);
				} else {
					trackedUnconfigured.push(path);
				}
			} else {
				untracked.push(path);
			}
		}

		return { trackedTextMode, hardDenylisted, trackedUnconfigured, untracked };
	}

	/**
	 * Known-tracked .obsidian/ paths, derived purely from existing baselines — a tracked
	 * path always has a known SHA by construction, so this needs no separate storage.
	 * Feeds LocalVault.configure({trackedHiddenPaths}) so local discovery can proactively
	 * probe these specific paths even when the broader hidden-file scan is off.
	 *
	 * Deliberately does NOT include trackedForCurrentSync (a path reconciled untracked→
	 * tracked earlier this same sync, before either baseline map is populated) — this is
	 * safe, not an oversight: FitSync's pre-sync reconcile block always either establishes
	 * a real baseline directly, or deletes lastFetchedRemoteShas[path] to force a remote
	 * change this sync, and any remote change for a path the local scan doesn't cover gets
	 * an independent direct filesystem check (util/changeTracking.ts's
	 * determineLocalChecksNeeded, #169) regardless of this list's contents. See
	 * docs/sync-logic.md § Baseline Recording for Untracked Files (#169).
	 */
	trackedObsidianPaths(): string[] {
		const paths = new Set<string>();
		for (const path of Object.keys(this.localShas)) {
			if (path.startsWith(".obsidian/")) paths.add(path);
		}
		for (const path of Object.keys(this.lastFetchedRemoteShas)) {
			if (path.startsWith(".obsidian/")) paths.add(path);
		}
		return [...paths];
	}

	/** Same-sync-only tracking override — see the trackedForCurrentSync field comment. */
	markTrackedForCurrentSync(paths: string[]): void {
		this.trackedForCurrentSync = new Set(paths);
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
				const message = `.fitattributes.json is malformed — no .obsidian/ paths will sync until it's fixed (${parsed.error})`;
				fitLogger.log(`[Fit] ${message}`);
				this.setFitAttributes({});
				this.fitAttributesWarning = message;
			}
		} catch (err) {
			// Exists but unreadable (I/O error, permission issue, etc.) — distinct from a
			// parse failure above. Unlike that case, this one can't reliably surface as a
			// visible Notice: the caller reached this catch either via getLocalChanges (whose
			// own LocalVault.readFromSource() already reads this same file as part of its
			// normal per-file scan, and throws/aborts the WHOLE sync on any unreadable tracked
			// file before this code path would even run for a failing read) or via
			// refreshFitAttributesForReconcile's eager path (which does reach here, but
			// getLocalChanges's later readFromSource call re-attempts the same failing read
			// and aborts the sync anyway, before the warning-Notice code downstream is
			// reached). So: log for debugging, but don't claim a user-visible warning that
			// can't actually appear — treat as unconfigured, matching the parse-failure case's
			// "nothing configured" fallback without pretending it's equally visible.
			const reason = err instanceof Error ? err.message : String(err);
			fitLogger.log(`[Fit] .fitattributes.json exists but could not be read (${reason})`);
			this.setFitAttributes({});
			this.fitAttributesWarning = null;
		}
	}

	/**
	 * Eagerly re-parses local .fitattributes.json content into this.fitAttributes, ahead of
	 * the normal per-sync local scan. Only worth calling when there's something that could
	 * actually be reconciled this sync (see FitSync's pre-sync reconcile block) — a local
	 * edit to .fitattributes.json needs to be visible to isEligibleForTracking() the SAME
	 * sync it was made, not delayed a sync like the general lazy update in getLocalChanges
	 * (which only updates fitAttributes from data the scan already touched). Checks existence
	 * via statPaths first so a call where the file doesn't exist touches nothing further.
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
		// Feed the tracked-path set to local hidden-path discovery before scanning.
		this.localVault.configure({ trackedHiddenPaths: this.trackedObsidianPaths() });

		fitLogger.log('.. 💾 [LocalVault] Scanning files...');
		const readResult = await this.localVault.readFromSource();
		const currentState = readResult.state;

		// Re-parse .fitattributes.json content (feeds shouldSyncPath's format gate) from this
		// scan's own knowledge of whether the file exists — never a separate stat/read probe,
		// so a sync where it simply doesn't exist touches it zero times. This runs before
		// shouldSyncPath filtering below, so a local edit made just before running sync
		// already gates this sync's own local push/pull decisions — no lag. The pre-sync
		// reconcile block (FitSync) is a separate consumer of this.fitAttributes with its own
		// eager refresh (refreshFitAttributesForReconcile), specifically so a
		// tracking-transition decision doesn't have to wait on this lazy path either.
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
