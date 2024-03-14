import { Plugin, SettingTab } from 'obsidian';
import { Fit, OctokitHttpError } from 'src/fit';
import FitNotice from 'src/fitNotice';
import { FitPull } from 'src/fitPull';
import { FitPush } from 'src/fitPush';
import FitSettingTab from 'src/fitSetting';
import { FitSync } from 'src/fitSync';
import { LocalChange } from 'src/fitTypes';
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
	fitPull: FitPull
	fitPush: FitPush
	fitSync: FitSync
	autoSyncing: boolean
	syncing: boolean
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
			// settingsNotice.setMessage("Settings not configured, please complete the following action items:\n" + actionItems.join("\n"))
			this.openPluginSettings()
			settingsNotice.remove("static")
			// this.removeFitNotice(settingsNotice, "static")
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
		syncNotice.setMessage("Performing pre sync checks.")


		const preSyncCheckResult = await this.fitSync.performPreSyncChecks();
		if (preSyncCheckResult.status === "inSync") {
			syncNotice.setMessage("Sync successful")
			return
		}

		if (preSyncCheckResult.status === "onlyRemoteCommitShaChanged") {
			const { latestRemoteCommitSha } = preSyncCheckResult.remoteUpdate
			await this.saveLocalStoreCallback({lastFetchedCommitSha: latestRemoteCommitSha})
			syncNotice.setMessage("Sync successful")
			return
		}

		const remoteUpdate = preSyncCheckResult.remoteUpdate
		if (preSyncCheckResult.status === "onlyRemoteChanged") {
			const fileOpsRecord = await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback)
			if (this.settings.notifyChanges) {
                showFileOpsRecord([{heading: "Local file updates:", ops: fileOpsRecord}])
            }
			syncNotice.setMessage("Sync successful")
			return
		}

		const {localChanges, localTreeSha} = preSyncCheckResult
		const localUpdate = {
			localChanges,
			localTreeSha,
			parentCommitSha: remoteUpdate.latestRemoteCommitSha
		}
		if (preSyncCheckResult.status === "onlyLocalChanged") {
			syncNotice.setMessage("Uploading local changes")
			await this.fitPush.pushChangedFilesToRemote(localUpdate, this.saveLocalStoreCallback)
			syncNotice.setMessage("Sync successful")
			return
		}
		
		// do both pull and push (orders of execution different from pullRemoteToLocal and 
		// pushChangedFilesToRemote to make this more transaction like, i.e. maintain original 
		// state if the transaction failed) If you have ideas on how to make this more transaction-like,
		//  please open an issue on the fit repo
		if (preSyncCheckResult.status === "localAndRemoteChangesCompatible") {
			const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
				remoteUpdate.remoteChanges)
			syncNotice.setMessage("Uploading local changes")
			const remoteTree = await this.fit.getTree(localUpdate.parentCommitSha)
			const createCommitResult = await this.fitPush.createCommitFromLocalUpdate(localUpdate, remoteTree)
			let latestRemoteTreeSha: Record<string, string>;
			let latestCommitSha: string;
			let pushedChanges: Array<LocalChange>;
			if (createCommitResult) {
				const {createdCommitSha} = createCommitResult
				const latestRefSha = await this.fit.updateRef(createdCommitSha)
				latestRemoteTreeSha = await this.fit.getRemoteTreeSha(latestRefSha)
				latestCommitSha = createdCommitSha
				pushedChanges = createCommitResult.pushedChanges
			} else {
				latestRemoteTreeSha = remoteUpdate.remoteTreeSha
				latestCommitSha = remoteUpdate.latestRemoteCommitSha
				pushedChanges = []
			}
			
			syncNotice.setMessage("Writing remote changes to local")
			const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)
			await this.saveLocalStoreCallback({
				lastFetchedRemoteSha: latestRemoteTreeSha, 
				lastFetchedCommitSha: latestCommitSha,
				localSha: await this.fit.computeLocalSha()
			})
			syncNotice.setMessage("Sync successful")
			if (this.settings.notifyChanges) {
				showFileOpsRecord([
					{heading: "Local file updates:", ops: localFileOpsRecord},
					{heading: "Remote file updates:", ops: pushedChanges},
				])
			}
		}

		if (preSyncCheckResult.status === "localAndRemoteChangesClashed") {
			const {latestRemoteCommitSha, clashedFiles, remoteTreeSha: latestRemoteTreeSha} = remoteUpdate
			const {noConflict, fileOpsRecord} = await this.fitSync.resolveConflicts(clashedFiles, latestRemoteTreeSha)
			if (noConflict) {
				// local changes is the same as remote changes, update localStore to track latest remote commit
				await this.saveLocalStoreCallback({
					lastFetchedRemoteSha: latestRemoteTreeSha, 
					lastFetchedCommitSha: latestRemoteCommitSha,
				})
				syncNotice.setMessage("Sync successful")
			} else {
				// TODO allow users to select displacement upon conflict (displace local changes or remote changes to _fit folder)
				syncNotice.setMessage(`Change conflicts detected`)
				const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
					remoteUpdate.remoteChanges)
				const syncLocalUpdate = {
					localChanges,
					localTreeSha: await this.fit.computeLocalSha(),
					parentCommitSha: latestRemoteCommitSha
				}
				const pushedChange = await this.fitPush.pushChangedFilesToRemote(syncLocalUpdate, this.saveLocalStoreCallback)
				const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)
				const ops = localFileOpsRecord.concat(fileOpsRecord)
				if (this.settings.notifyConflicts) {
					showUnappliedConflicts(clashedFiles)
				}
				if (this.settings.notifyChanges) {
					showFileOpsRecord([
						{heading: "Local file updates:", ops},
						{heading: "Remote file updates:", ops: pushedChange ?? []},
					])
				}
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
			notice.setMessage("Encountered unknown error during sync, view console log for details", true)
			return true
		}
	}

	loadRibbonIcons() {
		// Pull from remote then Push to remote if no clashing changes detected during pull
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Fit Sync', async (evt: MouseEvent) => {
			if ( this.syncing || this.autoSyncing ) { return }
			this.syncing = true
			this.fitSyncRibbonIconEl.addClass('animate-icon');
			const syncNotice = new FitNotice(this.fit, ["static"], "Initiating sync");
			const errorCaught = await this.catchErrorAndNotify(this.sync, syncNotice);
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
			if (errorCaught === true) {
				syncNotice.remove("error")
				this.syncing = false
				return
			}
			syncNotice.remove()
			this.syncing = false
		});
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
	}

	async autoUpdate() {
		if ( this.syncing || this.autoSyncing ) { return }
		this.autoSyncing = true
		const syncNotice = new FitNotice(
			this.fit, 
			["static"], 
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


	async onload() {
		await this.loadSettings();
		await this.loadLocalStore();
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fit = new Fit(this.settings, this.localStore, this.vaultOps)
		this.fitPull = new FitPull(this.fit)
		this.fitPush = new FitPush(this.fit)
		this.fitSync = new FitSync(this.fit)
		this.syncing = false
		this.autoSyncing = false
		this.settingTab = new FitSettingTab(this.app, this)
		this.loadRibbonIcons();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new FitSettingTab(this.app, this));

		// Check remote every X minutes to see if there are new commits
		this.registerInterval(window.setInterval(async () => {
			if (!(this.settings.autoSync === "off") && !this.syncing && !this.autoSyncing && this.checkSettingsConfigured()) {
				if (this.settings.autoSync === "on" || this.settings.autoSync === "muted") {
					this.autoUpdate()
				} else if (this.settings.autoSync === "remind") {
					const updatedRemoteCommitSha = await this.fitPull.remoteHasUpdates()
					if (updatedRemoteCommitSha) {
						const initialMessage = "Remote update detected, please pull the latest changes."
						const intervalNotice = new FitNotice(this.fit, ["static"], initialMessage,);
						intervalNotice.remove("static")
					} 
				}
			}
		}, this.settings.checkEveryXMinutes * 60 * 1000));
	}

	onunload() {}

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
		// sync settings to Fit class as well upon saving
		this.fit.loadSettings(this.settings)
	}
}
