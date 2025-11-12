/**
 * Obsidian Plugin Entry Point
 *
 * Defines the FitPlugin class and related types for Obsidian plugin integration.
 */

import { Plugin, SettingTab } from 'obsidian';
import { Fit } from 'src/fit';
import FitNotice from 'src/fitNotice';
import FitSettingTab from 'src/fitSetting';
import { FitSync } from 'src/fitSync';
import { showFileChanges, showUnappliedConflicts } from 'src/utils';
import { fitLogger } from 'src/logger';
import { CommitSha } from 'src/util/hashing';
import { FileStates } from 'src/util/changeTracking';
import { handleCriticalError } from 'src/util/errorHandling';

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
	pat: string;
	owner: string;
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
	localSha: FileStates                   // File path -> SHA cache
	lastFetchedCommitSha: CommitSha | null // Last synced commit
	lastFetchedRemoteSha: FileStates       // Remote file path -> SHA cache
}

const DEFAULT_LOCAL_STORE: LocalStores = {
	localSha: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteSha: {}
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
	autoSyncIntervalId: number | null;
	fitPullRibbonIconEl: HTMLElement;
	fitPushRibbonIconEl: HTMLElement;
	fitSyncRibbonIconEl: HTMLElement;
	private activeSyncRequests = 0; // Track number of active sync attempts
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
			actionItems.push("authenticate with personal access token");
		}
		if (this.settings.repo === "") {
			actionItems.push("select a repository to sync to");
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
	private async executeSync(triggerType: 'manual' | 'auto'): Promise<void> {
		if (!this.checkSettingsConfigured()) { return; }
		await this.loadLocalStore();

		fitLogger.log('[Plugin] Sync initiated', { triggerType });
		if (triggerType === 'auto') {
			fitLogger.log('[Plugin] Auto-sync mode', { mode: this.settings.autoSync });
		}

		const syncResult = await this.fitSync.sync(this.currentSyncNotice!);

		if (syncResult.success) {
			fitLogger.log('[Plugin] Sync completed successfully', {
				fileOpsCount: syncResult.changeGroups.length,
				unresolvedConflictsCount: syncResult.clash.length,
				operations: syncResult.changeGroups,
				unresolvedConflicts: syncResult.clash
			});

			if (this.settings.notifyConflicts) {
				showUnappliedConflicts(syncResult.clash);
			}
			if (this.settings.notifyChanges) {
				showFileChanges(syncResult.changeGroups);
			}

			// Show success completion state in notice
			if (triggerType === 'auto') {
				this.currentSyncNotice!.remove(); // Auto-sync hides notice completely
			} else {
				this.currentSyncNotice!.remove("done"); // Manual shows success state briefly
			}
		} else {
			// Handle already-syncing case - this is expected for concurrent requests
			if (syncResult.error.type === 'already-syncing') {
				// Don't modify the notice - it's being used by the active sync
				// The concurrent request just logs and returns
				fitLogger.log('[Plugin] Sync already in progress', { triggerType });
				return;
			}

			// Generate user-friendly message from structured sync error
			const errorMessage = this.fitSync.getSyncErrorMessage(syncResult.error);
			const fullMessage = `Sync failed: ${errorMessage}`;

			// Log detailed error information for debugging AND to file
			fitLogger.log('[Plugin] Sync failed', {
				errorType: syncResult.error.type,
				errorMessage: errorMessage,
				errorDetails: syncResult.error.details || {},
				fullMessage: fullMessage
			});

			console.error(fullMessage, {
				type: syncResult.error.type,
				...(syncResult.error.details || {})
			});

			this.currentSyncNotice!.setMessage(fullMessage, true);
			this.currentSyncNotice!.remove("error");
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

		this.onSyncStart(triggerType);
		try {
			await this.executeSync(triggerType);
		} finally {
			this.onSyncEnd(triggerType);
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
			await this.loadSettings();
			await this.loadLocalStore();

			// Initialize logger with vault and plugin directory for cross-platform diagnostics
			fitLogger.setVault(this.app.vault);
			if (this.manifest.dir) {
				fitLogger.setPluginDir(this.manifest.dir);
			}
			fitLogger.setEnabled(this.settings.enableDebugLogging);

			fitLogger.log('[Plugin] Starting plugin initialization');

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

	async loadLocalStore() {
		const localStore = Object.assign({}, DEFAULT_LOCAL_STORE, await this.loadData());
		const localStoreObj: LocalStores = Object.keys(DEFAULT_LOCAL_STORE).reduce(
			(obj, key: keyof LocalStores) => {
				if (localStore.hasOwnProperty(key)) {
					obj[key] = localStore[key];
				}
				return obj;
			}, {} as LocalStores);
		this.localStore = localStoreObj;
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
	}
}
