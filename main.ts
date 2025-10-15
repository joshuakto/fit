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
import { showFileOpsRecord, showUnappliedConflicts } from 'src/utils';

/**
 * Plugin configuration interface
 * Settings are persisted in Obsidian's plugin data storage
 */
export interface FitSettings {
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
	notifyConflicts: true
};


/**
 * Local state persistence interface
 * Tracks sync state between plugin sessions to enable incremental sync
 */
export interface LocalStores {
	localSha: Record<string, string>              // File path -> SHA cache
	lastFetchedCommitSha: string | null           // Last synced commit
	lastFetchedRemoteSha: Record<string, string>  // Remote file path -> SHA cache
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
	autoSyncing: boolean;
	syncing: boolean;
	autoSyncIntervalId: number | null;
	fitPullRibbonIconEl: HTMLElement;
	fitPushRibbonIconEl: HTMLElement;
	fitSyncRibbonIconEl: HTMLElement;

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

	sync = async (syncNotice: FitNotice): Promise<boolean> => {
		if (!this.checkSettingsConfigured()) { return false; }
		await this.loadLocalStore();
		const syncResult = await this.fitSync.sync(syncNotice);

		if (syncResult.success) {
			if (this.settings.notifyConflicts) {
				showUnappliedConflicts(syncResult.clash);
			}
			if (this.settings.notifyChanges) {
				showFileOpsRecord(syncResult.ops);
			}
			return true;
		} else {
			// Generate user-friendly message from structured sync error
			const errorMessage = this.fitSync.getSyncErrorMessage(syncResult.error);
			const fullMessage = `Sync failed: ${errorMessage}`;

			// Log detailed error information for debugging
			console.error(fullMessage, {
				type: syncResult.error.type,
				...(syncResult.error.details || {})
			});

			syncNotice.setMessage(fullMessage, true);
			return false;
		}
	};

	// Shared method for both ribbon icon and command palette
	performManualSync = async (): Promise<void> => {
		if ( this.syncing || this.autoSyncing ) { return; }
		this.syncing = true;
		this.fitSyncRibbonIconEl.addClass('animate-icon');
		const syncNotice = new FitNotice(this.fit, ["loading"], "Initiating sync");
		const syncSuccess = await this.sync(syncNotice);
		// TODO: Consider wrapping this in try-catch to ensure spinner always stops
		// even if sync() throws an unexpected exception
		this.fitSyncRibbonIconEl.removeClass('animate-icon');
		if (!syncSuccess) {
			syncNotice.remove("error");
		} else {
			syncNotice.remove("done");
		}
		this.syncing = false;
	};

	loadRibbonIcons() {
		// Pull from remote then Push to remote if no clashing changes detected during pull
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Fit Sync', this.performManualSync);
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
	}

	async autoSync() {
		if ( this.syncing || this.autoSyncing ) { return; }
		this.autoSyncing = true;
		const syncNotice = new FitNotice(
			this.fit,
			["loading"],
			"Auto syncing",
			0,
			this.settings.autoSync === "muted"
		);
		const syncSuccess = await this.sync(syncNotice);
		if (!syncSuccess) {
			syncNotice.remove("error");
		} else {
			syncNotice.remove();
		}
		this.autoSyncing = false;
	}

	async autoUpdate() {
		if (!(this.settings.autoSync === "off") && !this.syncing && !this.autoSyncing && this.checkSettingsConfigured()) {
			if (this.settings.autoSync === "on" || this.settings.autoSync === "muted") {
				await this.autoSync();
			} else if (this.settings.autoSync === "remind") {
				const { updated } = await this.fit.remoteUpdated();
				if (updated) {
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
			await this.autoUpdate();
		}, this.settings.checkEveryXMinutes * 60 * 1000);
	}

	async onload() {
		await this.loadSettings();
		await this.loadLocalStore();
		this.fit = new Fit(this.settings, this.localStore, this.app.vault);
		this.fitSync = new FitSync(this.fit, this.saveLocalStoreCallback);
		this.syncing = false;
		this.autoSyncing = false;
		this.settingTab = new FitSettingTab(this.app, this);
		this.loadRibbonIcons();

		// Add command to command palette for fit sync
		this.addCommand({
			id: 'fit-sync',
			name: 'Fit Sync',
			callback: this.performManualSync
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new FitSettingTab(this.app, this));

		// register interval to repeat auto check
		await this.startOrUpdateAutoSyncInterval();
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
					else if (key === "notifyChanges" || key === "notifyConflicts") {
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
