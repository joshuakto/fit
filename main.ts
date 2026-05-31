/**
 * Obsidian Plugin Entry Point
 *
 * Defines the FitPlugin class and related types for Obsidian plugin integration.
 */

import { Plugin, SettingTab } from 'obsidian';
import { Fit } from '@/fit';
import FitNotice from '@/fitNotice';
import FitSettingTab from '@/fitSetting';
import { FitSync } from '@/fitSync';
import { showFileChanges, showUnappliedConflicts } from '@/utils';
import { fitLogger } from '@/logger';
import { CommitSha } from '@/util/hashing';
import { FileStates } from '@/util/changeTracking';
import { handleCriticalError } from '@/util/errorHandling';
import { GitHubConnection } from '@/remotes/githubConnection';
import * as Encryption from "@/encryption";

/**
 * Plugin configuration interface
 * Settings are persisted in Obsidian's plugin data storage
 */
export interface FitSettings {
	// TODO: When adding support for multiple remote providers (GitLab, Gitea),
	// consider using a discriminated union structure:
	// remote: { provider: "github", pat: string, owner: string, ... }
	//       | { provider: "gitlab", token: string, project: string, ... }
	//       | { provider: "gitea", token: string, owner: string, ... }
	// This would allow type-safe, provider-specific settings.
	// See RemoteVaultProvider type in src/vault.ts for provider enum.
	encryptionPassword: string;
	pat: string;
	owner: string;       // Owner of the repo (may differ from authenticated user for contributor repos)
	avatarUrl: string;
	repo: string;
	branch: string;
	deviceName: string;
	checkEveryXMinutes: number
	autoSync: "on" | "off" | "muted" | "remind"
	notifyChanges: boolean
	notifyConflicts: boolean
	enableDebugLogging: boolean
}

const DEFAULT_SETTINGS: FitSettings = {
	encryptionPassword: "",
	pat: "",
	owner: "",
	avatarUrl: "",
	repo: "",
	branch: "",
	deviceName: "",
	checkEveryXMinutes: 5,
	autoSync: "off",
	notifyChanges: true,
	notifyConflicts: true,
	enableDebugLogging: true
};


/**
 * Local state persistence interface
 * Tracks sync state between plugin sessions to enable incremental sync
 */
export interface LocalStores {
	localShas: FileStates                  // Canonical git blob SHA cache (primary)
	// SHAs here use a legacy formula (SHA1(path + content)) that differs from canonical git blob SHA,
	// with content encoded as base64 for png/jpg/jpeg/pdf and as plaintext for everything else.
	// Downgrade notice: old client versions may find this field missing and see spurious local file
	// changes, but those trigger re-upload overhead only and rarely clash unless the same files were
	// also updated on remote during the same sync.
	localSha?: FileStates                  // Legacy path+content SHA cache (migration source only)
	lastFetchedCommitSha: CommitSha | null // Last synced commit
	lastFetchedRemoteShas: FileStates      // Canonical remote SHA cache
	lastFetchedRemoteSha?: FileStates      // Legacy field name — read-only fallback when loading old data
	// Files that were skipped due to GitHub API size limits (422) and haven't reached
	// remote yet. Maps path → SHA at time of skip, so we can detect when the file
	// has been modified locally (and should re-enter the normal sync queue) or reconciled
	// on remote (and should be removed from this list).
	// Note: transient failures like rate limits (#179) should be tracked separately when needed since they SHOULD retry on subsequent syncs.
	unpushedFiles?: FileStates
	// Paths with an unresolved _fit/ copy (pending clash state). localShas entry is absent
	// for these paths. Resolved when _fit/ is deleted or matches local content.
	// Downgrade-safe: absent field treated as empty array; missing localShas entry causes
	// false-positive re-push on old clients (overhead only, not data loss).
	pendingClashes?: string[]
}

/**
 * Discriminated union representing the outcome of a sync operation.
 * Separates business logic (sync result) from UI lifecycle management.
 */
type SyncOutcome =
	| { status: 'success'; result: Awaited<ReturnType<FitSync['sync']>> & { success: true } }
	| { status: 'already-syncing' }
	| { status: 'error'; error: { type: string; message: string; details?: Record<string, unknown> } }
	| { status: 'not-configured' };

const DEFAULT_LOCAL_STORE: LocalStores = {
	localShas: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteShas: {},
	unpushedFiles: {},
	pendingClashes: []
	// Note: no localSha — absent means no legacy data to migrate
};


/**
 * FIT Plugin - Obsidian integration layer for sync engine.
 *
 * Thin integration layer between Obsidian and the FIT sync engine.
 * Handles Obsidian-specific concerns only:
 * - Plugin lifecycle (load/unload)
 * - Settings UI and persistence
 * - Ribbon icons and commands
 * - Auto-sync scheduling
 * - Delegating to FitSync for all business logic
 *
 * Architecture:
 * - **Role**: Obsidian plugin lifecycle manager and UI coordinator
 * - **Delegates to**: FitSync (sync orchestration), Fit (data access)
 * - **Manages**: User settings, auto-sync intervals, UI notifications
 *
 * @see FitSync - The sync orchestrator (contains business logic)
 * @see Fit - Data access layer for local/remote storage
 */
export default class FitPlugin extends Plugin {
	settings: FitSettings;
	settingTab: FitSettingTab;
	localStore: LocalStores;
	fit: Fit;
	fitSync: FitSync;
	githubConnection: GitHubConnection | null;
	autoSyncIntervalId: number | null;
	fitPullRibbonIconEl: HTMLElement;
	fitPushRibbonIconEl: HTMLElement;
	fitSyncRibbonIconEl: HTMLElement;
	logger = fitLogger; // Explicit reference to singleton for future refactoring
	private activeSyncRequests = 0; // Track number of active sync attempts
	private lastGithubConnectionPat: string | null = null; // Track PAT changes
	private activeManualSyncRequests = 0; // Track number of active manual sync attempts
	private currentSyncNotice: FitNotice | null = null; // The active sync notice (shared by concurrent requests)

	// if settings not configured, open settings to let user quickly setup
	// Note: this is not a stable feature and might be disabled at any point in the future
	openPluginSettings() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const appWithSetting = this.app as any as {
			setting: {
				open(): void;
				openTabById(id: string): SettingTab | null;
			}
		};
		appWithSetting.setting.open();
		appWithSetting.setting.openTabById("fit");
	}

	checkSettingsConfigured(): boolean {
		const actionItems: Array<string> = [];
		if (this.settings.pat === "") {
			actionItems.push("provide GitHub personal access token");
		}
		if (this.settings.owner === "") {
			actionItems.push("select or enter a repository owner");
		}
		if (this.settings.repo === "") {
			actionItems.push("select or enter a repository to sync to");
		}
		if (this.settings.branch === "") {
			actionItems.push("select a branch to sync to");
		}

		if (actionItems.length > 0) {
			const initialMessage = "Settings not configured, please complete the following action items:\n" + actionItems.join("\n");
			const settingsNotice = new FitNotice(this.fit, ["static"], initialMessage);
			this.openPluginSettings();
			settingsNotice.remove("static");
			return false;

		}

		this.fit.loadSettings(this.settings);
		return true;
	}

	// use of arrow functions to ensure this refers to the FitPlugin class
	saveLocalStoreCallback = async (localStore: Partial<LocalStores>): Promise<void> => {
		await this.loadLocalStore();
		this.localStore = {...this.localStore, ...localStore};
		await this.saveLocalStore();
	};

	// ============================================================================
	// BUSINESS LOGIC LAYER
	// ============================================================================

	/**
	 * Execute sync operation with plugin-level concerns:
	 * - Settings validation
	 * - Local store loading
	 * - Result processing (notifications, error formatting)
	 * - Notice updates
	 */
	private async executeSync(triggerType: 'manual' | 'auto'): Promise<SyncOutcome> {
		if (!this.checkSettingsConfigured()) {
			return { status: 'not-configured' };
		}
		await this.loadLocalStore();

		const syncStartTime = Date.now();
		fitLogger.log(`🚀 [SYNC START] ${triggerType === 'manual' ? 'Manual' : 'Auto'} sync requested`);

		const syncResult = await this.fitSync.sync(this.currentSyncNotice!, { isAutoSync: triggerType === 'auto' });

		if (syncResult.success) {
			const duration = Date.now() - syncStartTime;
			const totalOps = syncResult.changeGroups.reduce((sum, g) => sum + g.changes.length, 0);
			const hasConflicts = syncResult.clash.length > 0;

			fitLogger.log(
				`✅ [SYNC COMPLETE] ${hasConflicts ? 'Success with conflicts' : 'Success'}`,
				{
					duration: `${(duration / 1000).toFixed(2)}s`,
					totalOperations: totalOps,
					conflicts: syncResult.clash.length,
					...(totalOps > 0 && { changes: syncResult.changeGroups }),
					...(hasConflicts && { unresolvedConflicts: syncResult.clash })
				}
			);

			return { status: 'success', result: syncResult };
		} else {
			// Handle already-syncing case - rare race between isActive check and sync() call
			if (syncResult.error.type === 'already-syncing') {
				fitLogger.log('[Plugin] Sync already in progress (race)', { triggerType });
				return { status: 'already-syncing' };
			}

			// Generate user-friendly message from structured sync error
			const errorMessage = this.fitSync.getSyncErrorMessage(syncResult.error);

			// Log detailed error information for debugging AND to file
			fitLogger.log('[Plugin] Sync failed', {
				type: syncResult.error.type,
				message: errorMessage,
				details: syncResult.error.details || {}
			});

			console.error(`Sync failed: ${errorMessage}`, {
				type: syncResult.error.type,
				...(syncResult.error.details || {})
			});

			return {
				status: 'error',
				error: {
					type: syncResult.error.type,
					message: errorMessage,
					details: syncResult.error.details
				}
			};
		}
	}

	// ============================================================================
	// UI LIFECYCLE MANAGEMENT
	// ============================================================================

	/**
	 * Handle sync start event - manages UI state when a sync request begins.
	 * Only creates notice/animation on the first active request.
	 */
	private onSyncStart(triggerType: 'manual' | 'auto'): void {
		// Track this sync attempt
		this.activeSyncRequests++;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests++;
		}

		// "Real" start = first request - create shared notice
		if (this.activeSyncRequests === 1) {
			this.currentSyncNotice = new FitNotice(
				this.fit,
				["loading"],
				triggerType === 'manual' ? "Initiating sync" : "Auto syncing",
				triggerType === 'manual' ? undefined : 0,  // Auto-sync: hide immediately on success
				triggerType === 'auto' && this.settings.autoSync === "muted"
			);
		}

		// Show animation if this is the first manual sync request
		if (triggerType === 'manual' && this.activeManualSyncRequests === 1) {
			this.fitSyncRibbonIconEl.addClass('animate-icon');
		}
	}

	/**
	 * Handles cleanup when a sync fails with an error.
	 * Unlike onSyncEnd, this does NOT nullify the notice reference,
	 * allowing error notices to remain visible until the user dismisses them.
	 */
	private onSyncError(triggerType: 'manual' | 'auto'): void {
		// Decrement counters
		this.activeSyncRequests--;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests--;
		}

		// Clear animation when all manual sync attempts complete
		if (this.activeManualSyncRequests === 0) {
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
		}

		// Note: We do NOT nullify this.currentSyncNotice here,
		// keeping the error notice alive for the user to dismiss manually.
	}

	/**
	 * Handle sync end event - manages UI state when a sync request completes.
	 * Only cleans up notice/animation on the last active request.
	 */
	private onSyncEnd(triggerType: 'manual' | 'auto'): void {
		// Decrement counters
		this.activeSyncRequests--;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests--;
		}

		// "Real" end = last request completes - clean up shared notice
		// Note: executeSync already handled success/error display, we just clean up the reference
		if (this.activeSyncRequests === 0) {
			this.currentSyncNotice = null;
		}

		// Clear animation when all manual sync attempts complete
		if (this.activeManualSyncRequests === 0) {
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
		}
	}

	// ============================================================================
	// COORDINATION LAYER (Decorator Pattern)
	// ============================================================================

	/**
	 * Wraps sync execution with UI lifecycle events (notice, animation).
	 * This is the "decorator" that adds UI coordination to the core sync operation.
	 */
	private async executeSyncWithUICoordination(triggerType: 'manual' | 'auto'): Promise<void> {
		fitLogger.log(`[Plugin] ${triggerType === 'manual' ? 'Manual' : 'Auto'} sync requested`);

		if (this.fitSync.isActive) {
			fitLogger.log('[Plugin] Sync already in progress - ignoring request', { triggerType });
			return;
		}

		this.onSyncStart(triggerType);

		let outcome: SyncOutcome;
		try {
			outcome = await this.executeSync(triggerType);
		} catch (error) {
			// Catch any unhandled exceptions (programming errors, unexpected failures)
			const errorMsg = error instanceof Error ? error.message : String(error);
			const fullMessage = `Sync failed unexpectedly: ${errorMsg}`;

			fitLogger.log('[Plugin] Unhandled sync error', {
				error: errorMsg,
				stack: error instanceof Error ? error.stack : undefined
			});

			console.error(fullMessage, error);

			// Show error in notice and clean up state
			this.currentSyncNotice?.setMessage(fullMessage, true);
			this.onSyncError(triggerType);
			return;
		}

		// Handle all sync outcomes with centralized UI lifecycle management
		switch (outcome.status) {
			case 'success':
				// Show optional notifications
				if (this.settings.notifyConflicts) {
					showUnappliedConflicts(outcome.result.clash);
				}
				if (this.settings.notifyChanges) {
					showFileChanges(outcome.result.changeGroups);
				}

				// Show success completion state in notice
				if (triggerType === 'auto') {
					this.currentSyncNotice!.remove(); // Auto-sync hides notice completely
				} else {
					this.currentSyncNotice!.remove("done"); // Manual shows success state briefly
				}

				// Clean up and nullify notice reference (success can nullify)
				this.onSyncEnd(triggerType);
				break;

			case 'already-syncing':
				// Rare race: passed isActive check but sync() was claimed before we reached it.
				// onSyncStart already ran, so undo its counter increment.
				this.onSyncEnd(triggerType);
				break;

			case 'not-configured':
				// Settings check failed, sync didn't start
				// No notice to clean up (onSyncStart didn't create one if settings invalid)
				this.onSyncError(triggerType);
				break;

			case 'error':
				// Show sticky error notice
				this.currentSyncNotice!.setMessage(`Sync failed: ${outcome.error.message}`, true);

				// Clean up state WITHOUT nullifying the error notice reference
				this.onSyncError(triggerType);
				break;
		}
	}

	// ============================================================================
	// PUBLIC ENTRY POINTS (User-triggered sync operations)
	// ============================================================================

	/**
	 * Entry point: User clicks ribbon icon or uses command palette
	 */
	triggerManualSync = async (): Promise<void> => {
		await this.executeSyncWithUICoordination('manual');
	};

	loadRibbonIcons() {
		// Pull from remote then Push to remote if no clashing changes detected during pull
		// TODO: Update title from "GitHub" to selected remote service when other services are supported.
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Sync to GitHub', this.triggerManualSync);
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
	}

	/**
	 * Entry point: Scheduled sync triggered (usually via timer)
	 */
	async handleAutoSyncTimer() {
		if (!(this.settings.autoSync === "off") && this.checkSettingsConfigured()) {
			if (this.settings.autoSync === "on" || this.settings.autoSync === "muted") {
				await this.executeSyncWithUICoordination('auto');
			} else if (this.settings.autoSync === "remind") {
				const { changes } = await this.fit.getRemoteChanges();
				if (changes.length > 0) {
					const initialMessage = "Remote update detected, please pull the latest changes.";
					const intervalNotice = new FitNotice(this.fit, ["static"], initialMessage);
					intervalNotice.remove("static");
				}
			}
		}
	}

	async startOrUpdateAutoSyncInterval() {
		// Clear existing interval if it exists
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		// Check remote every X minutes (set in settings)
		this.autoSyncIntervalId = window.setInterval(async () => {
			await this.handleAutoSyncTimer();
		}, this.settings.checkEveryXMinutes * 60 * 1000);
	}

	async onload() {
		try {
			// Initialize logger with vault and plugin directory for cross-platform diagnostics
			// This is done first so the logger is available if later initialization steps fail.
			if (this.manifest.dir) {
				fitLogger.configure(this.app.vault, this.manifest.dir);
			}

			await this.loadSettings();
			fitLogger.setEnabled(this.settings.enableDebugLogging);

			fitLogger.log('[Plugin] Starting plugin initialization');

			await this.loadLocalStore();

			Encryption.init(this);

			this.githubConnection = this.settings.pat
				? new GitHubConnection(this.settings.pat)
				: null;
			this.fit = new Fit(this.settings, this.localStore, this.app.vault);
			this.fitSync = new FitSync(this.fit, this.saveLocalStoreCallback);
			this.settingTab = new FitSettingTab(this.app, this);
			this.loadRibbonIcons();

			// Add command to command palette for fit sync
			this.addCommand({
				id: 'fit-sync',
				name: 'Fit Sync',
				callback: this.triggerManualSync
			});

			// This adds a settings tab so the user can configure various aspects of the plugin
			this.addSettingTab(new FitSettingTab(this.app, this));

			// register interval to repeat auto check
			await this.startOrUpdateAutoSyncInterval();

			fitLogger.log('[Plugin] Plugin initialization completed successfully');
		} catch (error) {
			handleCriticalError('Plugin failed to load', error, {
				logger: fitLogger,
				showNotice: true
			});
			throw error;
		}
	}

	onunload() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	async loadSettings() {
		const userSetting = await this.loadData();
		const settings = Object.assign({}, DEFAULT_SETTINGS, userSetting);
		const settingsObj: FitSettings = Object.keys(DEFAULT_SETTINGS).reduce(
			(obj, key: keyof FitSettings) => {
				if (settings.hasOwnProperty(key)) {
					if (key == "checkEveryXMinutes") {
						obj[key] = Number(settings[key]);
					}
					else if (key === "notifyChanges" || key === "notifyConflicts" || key === "enableDebugLogging") {
						obj[key] = Boolean(settings[key]);
					}
					else {
						obj[key] = settings[key];
					}
				}
				return obj;
			}, {} as FitSettings);
		this.settings = settingsObj;
	}

	// TODO: loadLocalStore and saveLocalStoreCallback are the persistence contract for all
	// sync state. Adding any new field to LocalStores requires updating BOTH this function
	// and saveLocalStoreCallback — they are not tested together (see follow-up PR for
	// main.ts integration tests). When adding a field: add it here with a ?? default,
	// add it to saveLocalStoreCallback, and add a round-trip test.
	async loadLocalStore() {
		const storedData = (await this.loadData()) ?? {};
		this.localStore = {
			localShas: storedData.localShas ?? {},
			localSha: storedData.localSha,                          // undefined if absent → omitted by JSON.stringify
			lastFetchedCommitSha: storedData.lastFetchedCommitSha ?? null,
			lastFetchedRemoteShas: storedData.lastFetchedRemoteSha ?? storedData.lastFetchedRemoteShas ?? {},
			lastFetchedRemoteSha: undefined,                        // consume legacy field name → omitted by JSON.stringify, removing it from storage
			unpushedFiles: storedData.unpushedFiles ?? {},
			pendingClashes: storedData.pendingClashes ?? [],
		};
	}

	// allow saving of local stores property, passed in properties will override existing stored value
	async saveLocalStore() {
		const data = Object.assign({}, DEFAULT_LOCAL_STORE, await this.loadData());
		await this.saveData({...data, ...this.localStore});
		// sync local store to Fit class as well upon saving
		this.fit.loadLocalStore(this.localStore);
	}

	async saveSettings() {
		const data = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		await this.saveData({...data, ...this.settings});
		// update auto sync interval with new setting
		this.startOrUpdateAutoSyncInterval();
		// sync settings to Fit class as well upon saving
		this.fit.loadSettings(this.settings);

		// Update GitHubConnection only when PAT changes
		if (this.settings.pat !== this.lastGithubConnectionPat) {
			if (this.settings.pat) {
				this.githubConnection = new GitHubConnection(this.settings.pat);
				this.lastGithubConnectionPat = this.settings.pat;
			} else {
				this.githubConnection = null;
				this.lastGithubConnectionPat = null;
			}
		}
	}
}
