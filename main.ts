import { Plugin, SettingTab } from 'obsidian';
import { Fit, OctokitHttpError } from 'src/fit';
import FitNotice from 'src/fitNotice';
import FitSettingTab from 'src/fitSetting';
import { FitSync } from 'src/fitSync';
import { showFileOpsRecord, showUnappliedConflicts } from 'src/utils';
import { VaultOperations } from 'src/vaultOps';

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
}


export interface LocalStores {
	localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
}

const DEFAULT_LOCAL_STORE: LocalStores = {
	localSha: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteSha: {}
}


export default class FitPlugin extends Plugin {
	settings: FitSettings;
	settingTab: FitSettingTab
	localStore: LocalStores
	fit: Fit;
	vaultOps: VaultOperations;
	fitSync: FitSync
	autoSyncing: boolean
	syncing: boolean
	autoSyncIntervalId: number | null
	fitPullRibbonIconEl: HTMLElement
	fitPushRibbonIconEl: HTMLElement
	fitSyncRibbonIconEl: HTMLElement

	// if settings not configured, open settings to let user quickly setup
	// Note: this is not a stable feature and might be disabled at any point in the future
	openPluginSettings() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const appWithSetting = this.app as any as {
			setting: {
				open(): void;
				openTabById(id: string): SettingTab | null;
			}
		}
		appWithSetting.setting.open()
		appWithSetting.setting.openTabById("fit")
	}

	checkSettingsConfigured(): boolean {
		const actionItems: Array<string> = []
		if (this.settings.pat === "") {
			actionItems.push("provide GitHub personal access token")
		}
		if (this.settings.owner === "") {
			actionItems.push("authenticate with personal access token")
		}
		if (this.settings.repo === "") {
			actionItems.push("select a repository to sync to")
		}
		if (this.settings.branch === "") {
			actionItems.push("select a branch to sync to")	
		}

		if (actionItems.length > 0) {
			const initialMessage = "Settings not configured, please complete the following action items:\n" + actionItems.join("\n")
			const settingsNotice = new FitNotice(this.fit, ["static"], initialMessage)
			this.openPluginSettings()
			settingsNotice.remove("static")
			return false

		}

		this.fit.loadSettings(this.settings)
		return true
	}

	// use of arrow functions to ensure this refers to the FitPlugin class
	saveLocalStoreCallback = async (localStore: Partial<LocalStores>): Promise<void> => {
		await this.loadLocalStore()
		this.localStore = {...this.localStore, ...localStore}
		await this.saveLocalStore()
	}
	
	sync = async (syncNotice: FitNotice): Promise<void> => {
		if (!this.checkSettingsConfigured()) { return }
		await this.loadLocalStore()
		const syncRecords = await this.fitSync.sync(syncNotice)
		if (syncRecords) {
			const {ops, clash} = syncRecords
			if (this.settings.notifyConflicts) {
				showUnappliedConflicts(clash)
			}
			if (this.settings.notifyChanges) {
				showFileOpsRecord(ops)
			}
		}
	}

	// wrapper to convert error to notice, return true if error is caught
	catchErrorAndNotify = async <P extends unknown[], R>(func: (notice: FitNotice, ...args: P) => Promise<R>, notice: FitNotice, ...args: P): Promise<R|true> => {
		try {
			const result = await func(notice, ...args)
			return result
		} catch (error) {
			if (error instanceof OctokitHttpError) {
				console.log("error.status")
				console.log(error.status)
				switch (error.source) {
					case 'getTree':
					case 'getRef':
						console.error("Caught error from getRef: ", error.message)
						if (error.status === 404) {
							notice.setMessage("Failed to get ref, make sure your repo name and branch name are set correctly.", true)
							return true
						}
						notice.setMessage("Unknown error in getting ref, refers to console for details.", true)
						return true
					case 'getCommitTreeSha':
					case 'getRemoteTreeSha':
					case 'createBlob':
					case 'createTreeNodeFromFile':
					case 'createCommit':
					case 'updateRef':
					case 'getBlob':
				}
				return true
			}
			console.error("Caught unknown error: ", error)
			notice.setMessage("Unable to sync, if you are not connected to the internet, turn off auto sync.", true)
			return true
		}
	}

	loadRibbonIcons() {
		// Pull from remote then Push to remote if no clashing changes detected during pull
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Fit Sync', async (evt: MouseEvent) => {
			if ( this.syncing || this.autoSyncing ) { return }
			this.syncing = true
			this.fitSyncRibbonIconEl.addClass('animate-icon');
			const syncNotice = new FitNotice(this.fit, ["loading"], "Initiating sync");
			const errorCaught = await this.catchErrorAndNotify(this.sync, syncNotice);
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
			if (errorCaught === true) {
				syncNotice.remove("error")
				this.syncing = false
				return
			}
			syncNotice.remove("done")
			this.syncing = false
		});
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
	}

	async autoSync() {
		if ( this.syncing || this.autoSyncing ) { return }
		this.autoSyncing = true
		const syncNotice = new FitNotice(
			this.fit, 
			["loading"], 
			"Auto syncing", 
			0, 
			this.settings.autoSync === "muted"
		);
		const errorCaught = await this.catchErrorAndNotify(this.sync, syncNotice);
		if (errorCaught === true) {
			syncNotice.remove("error")
		} else {
			syncNotice.remove()
		}
		this.autoSyncing = false
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
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fit = new Fit(this.settings, this.localStore, this.vaultOps)
		this.fitSync = new FitSync(this.fit, this.vaultOps, this.saveLocalStoreCallback)
		this.syncing = false
		this.autoSyncing = false
		this.settingTab = new FitSettingTab(this.app, this)
		this.loadRibbonIcons();

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
		const userSetting = await this.loadData()
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
		this.settings = settingsObj
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
		this.localStore = localStoreObj
	}

	// allow saving of local stores property, passed in properties will override existing stored value
	async saveLocalStore() {
		const data = Object.assign({}, DEFAULT_LOCAL_STORE, await this.loadData());
		await this.saveData({...data, ...this.localStore})
		// sync local store to Fit class as well upon saving
		this.fit.loadLocalStore(this.localStore)
	}

	async saveSettings() {
		const data = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		await this.saveData({...data, ...this.settings});
		// update auto sync interval with new setting
		this.startOrUpdateAutoSyncInterval();
		// sync settings to Fit class as well upon saving
		this.fit.loadSettings(this.settings)
	}
}
