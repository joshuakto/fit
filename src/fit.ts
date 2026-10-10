/**
 * Sync Coordinator and State Manager
 *
 * This module coordinates access to both local vault (LocalVault) and remote repository
 * (RemoteGitHubVault), and maintains sync state (cached SHAs for change detection).
 */

import { LocalStores } from "@/localStores";
import { FitSettings } from "@/fitSettings";
import { FitAttributeRule, FitAttributesFile, FITATTRIBUTES_PATH, parseFitAttributes, resolveSyncFormat as resolveSyncFormatPure, resolveScope as resolveScopePure } from "@/fitAttributes";
import { FileChange, FileStates, compareFileStates } from "./util/changeTracking";
import { Vault } from "obsidian";
import { LocalVault } from "./localVault";
import { RemoteGitHubVault } from "./remoteGitHubVault";
import { UnconfiguredRemoteVault } from "./unconfiguredRemoteVault";
import { IRemoteVault } from "./vault";
import { fitLogger } from "./logger";
import { CommitSha } from "./util/hashing";
import { ScanCoverage } from "./util/scanCoverage";
import { isHardDenylistedObsidianPath, FIT_OWN_SETTINGS_DENYLIST } from "./util/protectedPaths";

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
	// The next seven are assigned by loadLocalStore() from the constructor.
	localShas!: FileStates;                  // Canonical git blob SHA cache (primary, v2)
	localSha!: FileStates;                   // Legacy path+content SHA cache (migration source)
	lastFetchedCommitSha!: CommitSha | null; // Last synced commit SHA
	lastFetchedRemoteShas!: FileStates;      // Canonical remote SHA cache
	unpushedFiles!: FileStates;              // Files skipped due to API size limit (422)
	pendingClashes!: string[];               // Paths with unresolved _fit/ copies
	protectedPathShas!: FileStates;          // Remote SHAs for paths excluded by shouldSyncPath (dedup cache)
	fitAttributes: FitAttributesFile = {};  // Parsed from local .fitattributes.json; refreshed each sync
	// Set when the last .fitattributes.json parse attempt failed; null when it parsed fine or
	// the file doesn't exist. FitSync surfaces this as a visible Notice — a malformed file
	// silently means "no .obsidian/ path syncs", which is worse than noisy to leave log-only.
	fitAttributesWarning: string | null = null;
	localVault: LocalVault;                 // Local vault (tracks local file state)
	remoteVault: IRemoteVault = new UnconfiguredRemoteVault(); // Real vault once a PAT is configured (see loadSettings)
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
		if (!setting.owner && this.remoteVault.isConfigured) {
			return;
		}

		this.remoteVault = new RemoteGitHubVault(
			setting.pat,
			setting.owner,
			setting.repo,
			setting.branch,
			setting.deviceName,
			setting.githubHost
		);
	}

	/**
	 * Clear the remoteVault instance.
	 * Call this on authentication failure to allow re-creation on next attempt.
	 */
	clearRemoteVault() {
		this.remoteVault = new UnconfiguredRemoteVault();
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
	 * Whether a path goes through the normal full-file SHA-diff pipeline. Not the same
	 * as "does this path sync" — a `.obsidian/` path with `scope:"subset"` returns false
	 * here but still syncs, through `FitSync.syncSubsetScopePaths` instead (its own lane,
	 * masked field-level diffing instead of whole-file SHA comparison). See
	 * docs/sync-logic.md § Protected Paths.
	 *
	 * @param path - File path to check
	 * @returns true if path should go through the normal pipeline
	 */
	shouldSyncPath(path: string): boolean {
		// Exclude _fit/ directory (conflict resolution area)
		if (path.startsWith("_fit/")) {
			return false;
		}

		if (path.startsWith(".obsidian/")) {
			// Tracked purely by git content presence, never a local toggle — orthogonal
			// to isEligibleForTracking below (a path can be fully eligible and still not
			// tracked yet).
			const isTracked =
				path in this.localShas ||
				path in this.lastFetchedRemoteShas ||
				this.trackedForCurrentSync.has(path);
			if (!isTracked) return false;

			// scope:"subset" only ever comes from format:"json" (see resolveScope) — routed
			// to FitSync.syncSubsetScopePaths instead, so excluded here.
			if (this.resolveScope(path) === "subset") return false;
		}

		return this.isEligibleForTracking(path);
	}

	/**
	 * Whether a path is allowed to sync at all: not hard-denylisted, and resolveScope
	 * resolves to a non-null value.
	 *
	 * Split out from shouldSyncPath so the pre-sync reconcile block (FitSync) can ask this
	 * about a `.obsidian/` path about to become tracked, without depending on
	 * shouldSyncPath's own tracked-check.
	 */
	isEligibleForTracking(path: string): boolean {
		if (this.isHardDenylistedPath(path)) return false;
		return this.resolveScope(path) !== null;
	}

	/**
	 * The sync format that governs how an already-tracked path is merged — whole-file
	 * opaque replace ("text") vs structural JSON merge ("json", src/util/jsonMerge.ts).
	 * Explicit config always wins over the filetype heuristic. `null`: no extension
	 * match, unconfigured.
	 */
	resolveSyncFormat(path: string): FitAttributeRule['format'] | null {
		return resolveSyncFormatPure(path, this.fitAttributes);
	}

	/**
	 * How much of a tracked path syncs — "full" (whole file) or "subset" (field-level
	 * masking, only tracked keys). Explicit config always wins. Default:
	 * - Ordinary (non-`.obsidian/`) path: "full", unconditionally.
	 * - Protected `.obsidian/` path: "full" for format:"text", "subset" for format:"json",
	 *   `null` otherwise.
	 */
	resolveScope(path: string): FitAttributeRule['scope'] | null {
		return resolveScopePure(path, this.fitAttributes);
	}

	/**
	 * Path-specific unsafe-field denylist, on top of the universal one
	 * (UNIVERSAL_SECRET_FIELD_DENYLIST, always applied by FitSync.resolveSubsetScopePath
	 * to every scope:"subset" path regardless of this method). `null` for every path
	 * except `ownDataPath` — FIT's own data.json, resolved dynamically from the plugin's
	 * actual install dir (`.obsidian/plugins/<pluginDir>/data.json`, follows an alternate
	 * install name like `fit-dev`).
	 *
	 * resolveSyncFormat/resolveScope never consult this — ownDataPath gets its "subset"
	 * default the same way any other protected json path does. Consulted separately, where
	 * content is actually applied: readAndApplyFitAttributes rejects a user config entry
	 * targeting this path, and resolveSubsetScopePath strips these fields from content.
	 */
	safeFieldDenylist(path: string): readonly string[] | null {
		return path === this.ownDataPath ? FIT_OWN_SETTINGS_DENYLIST : null;
	}

	/**
	 * A `.obsidian/` path that is currently actively syncing (tracked + format-eligible).
	 * For these paths, a remote REMOVED is ambiguous between "the file was actually
	 * deleted" and "someone removed it from the repo to stop syncing it" — the latter is
	 * the documented way to untrack a git-mask path (see docs/sync-logic.md § Protected
	 * Paths). resolveAllChanges uses this to route such removals to untrackNotices (a
	 * one-time, this-sync-only Notice item — see FitSync.sync) instead of auto-deleting
	 * the local file. Non-`.obsidian/` paths are always false —
	 * ordinary tracked files have no such ambiguity, remote deletion just means deletion.
	 */
	isGitMaskTrackedPath(path: string): boolean {
		return path.startsWith(".obsidian/") && this.shouldSyncPath(path);
	}

	/** Path-level hard denylist — see src/util/protectedPaths.ts for the "why". */
	isHardDenylistedPath(path: string): boolean {
		return isHardDenylistedObsidianPath(path);
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
	): { trackedSyncing: string[]; hardDenylisted: string[]; trackedUnconfigured: string[]; untracked: string[] } {
		const candidates = new Set<string>();
		for (const path of Object.keys(currentLocalState)) {
			if (path.startsWith(".obsidian/")) candidates.add(path);
		}
		for (const path of Object.keys(remoteState)) {
			if (path.startsWith(".obsidian/")) candidates.add(path);
		}

		const trackedSyncing: string[] = [];
		const hardDenylisted: string[] = [];
		const trackedUnconfigured: string[] = [];
		const untracked: string[] = [];

		for (const path of [...candidates].sort()) {
			if (this.isHardDenylistedPath(path)) {
				hardDenylisted.push(path);
			} else if (path in remoteState) {
				// format: "json" alone is incomplete for a protected path (see
				// isEligibleForTracking) — bucketed with "unconfigured", not "syncing".
				if (this.isEligibleForTracking(path)) {
					trackedSyncing.push(path);
				} else {
					trackedUnconfigured.push(path);
				}
			} else {
				untracked.push(path);
			}
		}

		return { trackedSyncing, hardDenylisted, trackedUnconfigured, untracked };
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
	// Known gap: always trusts local disk content, even if .fitattributes.json itself has
	// an unresolved pending clash with remote — see docs/sync-logic.md § .fitattributes.json
	// (#337) → "Known gap — self-clash not consulted".
	private async readAndApplyFitAttributes(): Promise<void> {
		try {
			const fitAttributesContent = await this.localVault.readFileContent(FITATTRIBUTES_PATH);
			const parsed = parseFitAttributes(fitAttributesContent.toPlainText());
			if (parsed.ok) {
				// A denylisted path's config has no effect either way (safeFieldDenylist),
				// so drop it here just to avoid it silently looking "applied". Scoped to
				// just that entry — every other rule here is independently valid.
				const messages: string[] = [];
				if (parsed.invalidRules.length > 0) {
					messages.push(`.fitattributes.json: ${parsed.invalidRules.length === 1 ? 'this rule is' : 'these rules are'} invalid and ignored (${parsed.invalidRules.map(r => r.error).join('; ')}) — every other rule still applies`);
				}
				const nonConfigurablePaths = Object.keys(parsed.value).filter(path => this.safeFieldDenylist(path));
				if (nonConfigurablePaths.length > 0) {
					for (const path of nonConfigurablePaths) delete parsed.value[path];
					messages.push(`.fitattributes.json: ${nonConfigurablePaths.map(p => `"${p}"`).join(', ')} ${nonConfigurablePaths.length === 1 ? 'is' : 'are'} not configurable (sync behavior fixed internally) — ${nonConfigurablePaths.length === 1 ? 'this entry has' : 'these entries have'} no effect and should be removed`);
				}
				for (const message of messages) fitLogger.log(`[Fit] ${message}`);
				this.fitAttributesWarning = messages.length > 0 ? messages.join('\n') : null;
				this.setFitAttributes(parsed.value);
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

	async getLocalChanges(): Promise<{
		changes: FileChange[],
		state: FileStates,
		scanCoverage: ScanCoverage,
		unlistablePaths: string[],
		ignoredTrackedPaths: string[]
	}> {
		// Feed the tracked-path set to local hidden-path discovery before scanning, and the
		// baseline so a .gitignore rule only gates adding new paths.
		this.localVault.configure({
			trackedHiddenPaths: this.trackedObsidianPaths(),
			baselinePaths: Object.keys(this.localShas)
		});

		fitLogger.log('.. 💾 [LocalVault] Scanning files...');
		const readResult = await this.localVault.readFromSource();
		const currentState = readResult.state;
		const scanCoverage = new ScanCoverage(currentState, readResult.orphanedScanPrefixes);

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

		// See docs/sync-logic.md § Scan-time pruning vs. the stored baseline — without
		// this, a baseline entry the scan did not look for reads as a local REMOVED, though
		// the file is still on disk.
		const isUnscanned = (path: string) => scanCoverage.statusOf(path) === 'unknown';

		// Filter both states to paths that are trackable AND syncable (#169).
		// shouldTrackState: LocalVault can read the file (always true when syncHiddenFiles=true).
		// shouldSyncPath: sync policy allows pushing (filters _fit/, .obsidian/, etc.).
		// Both required — protected paths like .obsidian/ are readable but never pushed,
		// and would appear as phantom ADDED changes without this combined filter.
		const isSyncCandidate = (path: string) =>
			this.localVault.shouldTrackState(path) && this.shouldSyncPath(path) && !isUnscanned(path);

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
		return {
			changes, state: currentState, scanCoverage,
			unlistablePaths: readResult.unlistablePaths,
			ignoredTrackedPaths: readResult.ignoredTrackedPaths
		};
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
