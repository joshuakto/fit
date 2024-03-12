import { Notice, Plugin, SettingTab } from 'obsidian';
import { Fit, OctokitHttpError } from 'src/fit';
import { FitPull } from 'src/fitPull';
import { FitPush } from 'src/fitPush';
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
}

const DEFAULT_SETTINGS: FitSettings = {
	pat: "",
	owner: "",
	avatarUrl: "",
	repo: "",
	branch: "",
	deviceName: "",
	checkEveryXMinutes: 5
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
	pulling: boolean
	pushing: boolean
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
			const settingsNotice = this.initializeFitNotice(["static"])
			settingsNotice.setMessage("Settings not configured, please complete the following action items:\n" + actionItems.join("\n"))
			this.openPluginSettings()
			this.removeFitNotice(settingsNotice, "static")
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
	
	sync = async (syncNotice: Notice): Promise<void> => {
		if (!this.checkSettingsConfigured()) { return }
		await this.loadLocalStore()
		syncNotice.setMessage("Performing pre sync checks.")


		const preSyncCheckResult = await this.fitSync.performPreSyncChecks();
		if (preSyncCheckResult.status === "inSync") {
			// syncNotice.setMessage("Local and remote in sync, no file operations performed.")
			syncNotice.setMessage("Sync successful")
			return
		}

		if (preSyncCheckResult.status === "onlyRemoteCommitShaChanged") {
			const { latestRemoteCommitSha } = preSyncCheckResult.remoteUpdate
			await this.saveLocalStoreCallback({lastFetchedCommitSha: latestRemoteCommitSha})
			// syncNotice.setMessage("Local and remote in sync, tracking latest remote commit.")
			syncNotice.setMessage("Sync successful")
			return
		}

		const remoteUpdate = preSyncCheckResult.remoteUpdate
		if (preSyncCheckResult.status === "onlyRemoteChanged") {
			await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback)
			// syncNotice.setMessage("Sync complete, remote changes pulled to local copy.")
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
			// syncNotice.setMessage("Only local changes detected, pushing to remote.")
			syncNotice.setMessage("Uploading local changes")
			await this.fitPush.pushChangedFilesToRemote(localUpdate, this.saveLocalStoreCallback)
			// syncNotice.setMessage("No remote changes detected, local changes pushed to remote.")
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
			const createdCommitSha = await this.fitPush.createCommitFromLocalUpdate(localUpdate)
			
			const updatedRefSha = await this.fit.updateRef(createdCommitSha)

			// syncNotice.setMessage("Local changes pushed to remote.")
			syncNotice.setMessage("Downloading remote changes")
            const updatedRemoteTreeSha = await this.fit.getRemoteTreeSha(updatedRefSha)
			const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)
			await this.saveLocalStoreCallback({
				lastFetchedRemoteSha: updatedRemoteTreeSha, 
				lastFetchedCommitSha: createdCommitSha,
				localSha: await this.fit.computeLocalSha()
			})
			// syncNotice.setMessage("Local and remote now in sync.")
			syncNotice.setMessage("Sync successful")
			showFileOpsRecord(localChanges, "Remote file updates:")
			showFileOpsRecord(localFileOpsRecord, "Local file updates:")
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
				// syncNotice.setMessage("Local changes compatiable with remote changes, updated to track latest remote commit.")
				syncNotice.setMessage("Sync successful")
			} else {
				// TODO allow users to select displacement upon conflict (displace local changes or remote changes to _fit folder)
				// const displaceChangesUponConflict = "remote"
				// if (displaceChangesUponConflict === "remote") {
				syncNotice.setMessage(`Change conflict detected`)
				const syncLocalUpdate = {
					localChanges,
					localTreeSha: await this.fit.computeLocalSha(),
					parentCommitSha: latestRemoteCommitSha
				}
				await this.fitPush.pushChangedFilesToRemote(syncLocalUpdate, this.saveLocalStoreCallback, true)
				syncNotice.setMessage(`Local changes uploaded, conflicting remote changes written in _fit`)
				// } else {
				// 	syncNotice.setMessage(`Local changes clashes with remote changes, moving clashed local files to _fit.`)
				// 	await Promise.all(localChanges.map(c => this.vaultOps.createCopyInDir(c.path, "_fit")))
				// 	syncNotice.setMessage(`Conflicting local changes moved to _fit folder:\n${noticeMsg}`)
				// 	await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback)
				// 	syncNotice.setMessage(`Pulled remote changes to local, conflicting local changes moved to _fit folder.`)
				// }
				showUnappliedConflicts(clashedFiles)

			}
			showFileOpsRecord(localChanges, "Remote file updates:")
			showFileOpsRecord(fileOpsRecord, "Local file updates:")
		}


	}

	// wrapper to convert error to notice, return true if error is caught
	catchErrorAndNotify = async <P extends unknown[], R>(func: (notice: Notice, ...args: P) => Promise<R>, notice: Notice, ...args: P): Promise<R|true> => {
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
							notice.setMessage("Failed to get ref, make sure your repo name and branch name are set correctly.")
							return true
						}
						notice.setMessage("Unknown error in getting ref, refers to console for details.")
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
			notice.setMessage("Encountered unknown error during sync, view console log for details")
			return true
		}
	}

	initializeFitNotice(addClasses = ["loading"], initialMessage?: string): Notice {
		// keep at least one empty space to make the height consistent
		const notice = new Notice((initialMessage && initialMessage.length > 0)? initialMessage : " ", 0)
		notice.noticeEl.addClass("fit-notice")	
		addClasses.map(cls => notice.noticeEl.addClass(cls))
		return notice
	}



	removeFitNotice(notice: Notice, finalClass?: string): void {
		notice.noticeEl.removeClass("loading")
		if (finalClass) {
			notice.noticeEl.addClass(finalClass)
		} else {
			notice.noticeEl.addClass("done")
		}
		setTimeout(() => notice.hide(), 4000)
	}

	loadRibbonIcons() {
		// Pull from remote then Push to remote if no clashing changes detected during pull
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Fit Sync', async (evt: MouseEvent) => {
			if (this.syncing || this.pulling || this.pushing) { return }
			this.syncing = true
			this.fitSyncRibbonIconEl.addClass('animate-icon');
			const syncNotice = this.initializeFitNotice();
			const errorCaught = await this.catchErrorAndNotify(this.sync, syncNotice);
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
			if (errorCaught === true) {
				this.removeFitNotice(syncNotice, "error")
				this.syncing = false
				return
			}
			this.removeFitNotice(syncNotice)
			this.syncing = false
		});
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
	}


	async onload() {
		await this.loadSettings();
		await this.loadLocalStore();
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fit = new Fit(this.settings, this.localStore, this.vaultOps)
		this.fitPull = new FitPull(this.fit)
		this.fitPush = new FitPush(this.fit)
		this.fitSync = new FitSync(this.fit)
		this.pulling = false
		this.pushing = false
		this.syncing = false
		this.settingTab = new FitSettingTab(this.app, this)
		this.loadRibbonIcons();


		this.addCommand({
			id: 'debug',
			name: 'debug',
			callback: async () => {
				const abc = new Notice("", 0)
				const heading = abc.noticeEl.createEl("span")
				heading.setText("File changes\n")
				heading.addClass("file-changes-heading")
				const createdH = abc.noticeEl.createEl("span")
				createdH.setText("Created\n")
				createdH.addClass("file-changes-subheading")
				const abcde = ['a','b', 'c', 'd', 'e']
				abcde.map((char) => {
					const listItem = abc.noticeEl.createEl("li");
					listItem.setText(`${char}`);
					listItem.addClass("file-created");
				});
				const changeH = abc.noticeEl.createEl("span")
				changeH.setText("Changed\n")
				changeH.addClass("file-changes-subheading")
				const hij = ['j','h', 'i']
				hij.map((char) => {
					const listItem = abc.noticeEl.createEl("li");
					listItem.setText(`${char}`);
					listItem.addClass("file-changed");
				});
				const deleteH = abc.noticeEl.createEl("span")
				deleteH.setText("Deleted\n")
				deleteH.addClass("file-changes-subheading")
				const ijk = ['j','k', 'i']
				ijk.map((char) => {
					const listItem = abc.noticeEl.createEl("li");
					listItem.setText(`${char}`);
					listItem.addClass("file-deleted");
				});
				ijk.map((char) => {
					const listItem = abc.noticeEl.createEl("li");
					listItem.setText(`${char}`);
					listItem.addClass("file-deleted");
				});
				
				const conflictHeading = abc.noticeEl.createEl("span")
				conflictHeading.setText("Conflict to be resolved:\n")
				conflictHeading.addClass("file-changes-heading")
				const conflictStatus = abc.noticeEl.createDiv({
					cls: "file-conflict-row"
				});
				conflictStatus.createDiv().setText("Local")
				conflictStatus.createDiv().setText("Remote")
				const conflictItem = abc.noticeEl.createDiv({
					cls: "file-conflict-row"
				});
				conflictItem.createDiv({
					cls: "file-conflict-delete"
				});
				conflictItem.createDiv("div")
					.setText("File Path");
				conflictItem.createDiv({
					cls: "file-conflict-create"
				});
				const footer = abc.noticeEl.createDiv({
					cls: "file-conflict-row"
				})
				footer.setText("Note:")
				footer.style.fontWeight = "bold";
				abc.noticeEl.createEl("li", {cls: "file-conflict-note"})
					.setText("Remote changes in _fit")
				abc.noticeEl.createEl("li", {cls: "file-conflict-note"})
					.setText("_fit folder is overwritten on conflict, copy needed changes outside _fit.")

				console.log(abc.noticeEl)
			}
		});


		// recompute local sha to unblock pulling
		this.addCommand({
			id: 'recompute-local-sha',
			name: `Update local store with new local sha, to unblock pulling when local clashes are detected (Dangerous!
				Running pull after this command will discard local changes, please backup vault before running this.)`,
				callback: async () => {
					this.localStore.localSha = await this.fit.computeLocalSha()
					this.saveLocalStore()
					new Notice(`Stored local sha recomputation, recent local changes will not be considered in future push/pull.`)
				}
			});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new FitSettingTab(this.app, this));

		// Check remote every 5 minutes to see if there are new commits
		this.registerInterval(window.setInterval(async () => {
			if (this.checkSettingsConfigured()) {
				const updatedRemoteCommitSha = await this.fitPull.remoteHasUpdates()
				if (updatedRemoteCommitSha) {
					const intervalNotice = this.initializeFitNotice(["static"]);
					intervalNotice.setMessage("Remote update detected, please pull the latest changes.")
					this.removeFitNotice(intervalNotice)
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
					// if (key == "singleButtonMode") {
						// obj[key] = Boolean(settings[key]);
					// } else 
					if (key == "checkEveryXMinutes") {
						obj[key] = Number(settings[key]);
					} else {
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
