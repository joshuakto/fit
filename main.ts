import { Notice, Plugin, base64ToArrayBuffer } from 'obsidian';
import { ComputeFileLocalShaModal, DebugModal } from 'src/pluginModal';
import { Fit, OctokitHttpError } from 'src/fit';
import { FitPull } from 'src/fitPull';
import { FitPush } from 'src/fitPush';
import FitSettingTab from 'src/fitSetting';
import { VaultOperations } from 'src/vaultOps';

export interface FitSettings {
	pat: string;
	owner: string;
	repo: string;
	branch: string;
	deviceName: string;
	singleButtonMode: boolean
	checkEveryXMinutes: number
}

const DEFAULT_SETTINGS: FitSettings = {
	pat: "",
	owner: "",
	repo: "",
	branch: "",
	deviceName: "",
	singleButtonMode: true,
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
	localStore: LocalStores
	fit: Fit;
	vaultOps: VaultOperations;
	fitPull: FitPull
	fitPush: FitPush
	pulling: boolean
	pushing: boolean
	syncing: boolean
	fitPullRibbonIconEl: HTMLElement
	fitPushRibbonIconEl: HTMLElement
	fitSyncRibbonIconEl: HTMLElement

	checkSettingsConfigured(): boolean {
		if (this.settings.pat === "") {
			new Notice("Please provide git personal access tokens in Fit settings and try again.")
			return false
		}
		if (this.settings.owner === "") {
			new Notice("Please provide git repo owner in Fit settings and try again.")
			return false
		}
		if (this.settings.repo === "") {
			this.settings.repo = `obsidian-${this.app.vault.getName()}-storage`
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
		const localChanges = await this.fit.getLocalChanges()
		const preSyncChecks = await this.fitPull.performPrePullChecks(localChanges)
		if (preSyncChecks.status === "localCopyUpToDate" && localChanges.length === 0) {
			syncNotice.setMessage("Local and remote in sync, no file operations performed.")
		} 
		else if (preSyncChecks.status === "localCopyUpToDate" && localChanges.length > 0) {
			// push local changes to remote
			const localUpdate = {
				localChanges,
				localTreeSha: await this.fit.computeLocalSha(),
				// localStore must have value for localCopyUpToDate status to be returned
				parentCommitSha: this.localStore.lastFetchedCommitSha as string
			}
			await this.fitPush.pushChangedFilesToRemote(localUpdate, this.saveLocalStoreCallback)
			syncNotice.setMessage("Local copy up to date, pushed detected changes to remote.")
		} 
		else if (preSyncChecks.status === "noRemoteChangesDetected" && localChanges.length === 0) {
			const { latestRemoteCommitSha } = preSyncChecks.remoteUpdate
			await this.saveLocalStoreCallback({lastFetchedCommitSha: latestRemoteCommitSha})
			syncNotice.setMessage("Local and remote in sync, tracking latest remote commit.")
		} 
		else if (preSyncChecks.status === "noRemoteChangesDetected" && localChanges.length > 0) {
			const { latestRemoteCommitSha } = preSyncChecks.remoteUpdate
			const localUpdate = {
				localChanges,
				localTreeSha: await this.fit.computeLocalSha(),
				parentCommitSha: latestRemoteCommitSha
			}
			await this.fitPush.pushChangedFilesToRemote(localUpdate, this.saveLocalStoreCallback)
			syncNotice.setMessage("No remote changes detected, pushed local changes to remote.")
		}
		else if (preSyncChecks.status === "localChangesClashWithRemoteChanges") {
			syncNotice.setMessage("Local changes clash with remote changes, aborting sync, files are unmodified.")
		}
		else if (preSyncChecks.status === "remoteChangesCanBeMerged" && localChanges.length === 0) {
			await this.fitPull.pullRemoteToLocal(preSyncChecks.remoteUpdate, this.saveLocalStoreCallback)
			syncNotice.setMessage("Sync complete, remote changes pulled to local copy.")
		}
		else if (preSyncChecks.status === "remoteChangesCanBeMerged" && localChanges.length > 0) {
			// do both pull and push
			// (orders of execution different from pullRemoteToLocal and pushChangedFilesToRemote to 
			// make this more transaction like, i.e. maintain original state if the transaction failed)
			// If you have an idea on how to make this more transaction-like, please open an issue on 
			// the fit repo
			const {remoteUpdate} = preSyncChecks
			const localUpdate = {
				localChanges,
				localTreeSha: await this.fit.computeLocalSha(),
				parentCommitSha: remoteUpdate.latestRemoteCommitSha
			}
			const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
				remoteUpdate.remoteChanges)
			const createdCommitSha = await this.fitPush.createCommitFromLocalUpdate(localUpdate)
			const updatedRefSha = await this.fit.updateRef(createdCommitSha)
			syncNotice.setMessage("Local changes pushed to remote.")
            const updatedRemoteTreeSha = await this.fit.getRemoteTreeSha(updatedRefSha)
			await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)
			syncNotice.setMessage("Remote changes written to local drive.")
			await this.saveLocalStoreCallback({
				lastFetchedRemoteSha: updatedRemoteTreeSha, 
				lastFetchedCommitSha: createdCommitSha,
				localSha: await this.fit.computeLocalSha()
			})
			syncNotice.setMessage("Local and remote now in sync.")
		}
	}

	pull = async (pullNotice: Notice): Promise<void> => {
		if (!this.checkSettingsConfigured()) { return }
		await this.loadLocalStore()
		pullNotice.setMessage("Performing pre pull checks.")
		const prePullCheckResult = await this.fitPull.performPrePullChecks()
		if (prePullCheckResult.status === "localCopyUpToDate") {
			pullNotice.setMessage("Local copy already up to date")
		} else if (prePullCheckResult.status === "localChangesClashWithRemoteChanges") {
			// TODO provide a way for users to resolve clashes
			pullNotice.setMessage("Local changes clashed with remote changes, please resolve and try again.")
		} else if (prePullCheckResult.status === "remoteChangesCanBeMerged") {
			pullNotice.setMessage("Pre pull checks successful, pulling changes from remote.")
			const remoteUpdate = prePullCheckResult.remoteUpdate
			await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback)
			pullNotice.setMessage("Pull complete, local copy up to date.")
		} else if (prePullCheckResult.status === "noRemoteChangesDetected") {
			const {latestRemoteCommitSha: lastFetchedCommitSha} = prePullCheckResult.remoteUpdate
			this.saveLocalStoreCallback({lastFetchedCommitSha})
			pullNotice.setMessage("No remote changes detected, local copy set to track latest commit.")
		}
		return
	}

	push = async (pushNotice: Notice): Promise<void> => {
		pushNotice.setMessage("Performing pre push checks.")
		if (!this.checkSettingsConfigured()) { 
			this.pushing = false
			return
		}
		await this.loadLocalStore()
		const prePushCheckResult = await this.fitPush.performPrePushChecks()
		if (prePushCheckResult.status === "noLocalChangesDetected") {
			pushNotice.setMessage("No local changes detected.")
		} else if (prePushCheckResult.status === "remoteChanged") {
			pushNotice.setMessage("Remote changed after last pull/write, please pull again.")
		} else if (prePushCheckResult.status === "localChangesCanBePushed") {
			const localUpdate = prePushCheckResult.localUpdate
			pushNotice.setMessage("Pre push checks successful, pushing local changes to remote.")
			await this.fitPush.pushChangedFilesToRemote(localUpdate, this.saveLocalStoreCallback)
			pushNotice.setMessage(`Successful pushed to ${this.fit.repo}`)
		}
		return
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
			notice.setMessage("Encountered unknown error during sync, view console log for details")
			return true
		}
	}

	initializeFitNotice(addClasses = ["loading"]): Notice {
		const notice = new Notice(" ", 0) // keep at least one empty space to make the height consistent
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

	updateRibbonIcons() {
		if (this.settings.singleButtonMode) {
			this.fitSyncRibbonIconEl.removeClass("hide");
			this.fitPullRibbonIconEl.addClass("hide");
			this.fitPushRibbonIconEl.addClass("hide");
		} else {
			this.fitSyncRibbonIconEl.addClass("hide");
			this.fitPullRibbonIconEl.removeClass("hide");
			this.fitPushRibbonIconEl.removeClass("hide");
		}
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
		
		// Pull remote to local
		this.fitPullRibbonIconEl = this.addRibbonIcon("github", 'Fit pull', async (evt: MouseEvent) => {
			if (this.syncing || this.pulling || this.pushing) { return }
			this.pulling = true
			this.fitPullRibbonIconEl.addClass('animate-icon')
			const pullNotice = this.initializeFitNotice();
			const errorCaught = await this.catchErrorAndNotify(this.pull, pullNotice);
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
			if (errorCaught === true) {
				this.removeFitNotice(pullNotice, "error")
				this.pulling = false
				return
			}
			this.removeFitNotice(pullNotice)
			this.pulling = false
			this.fitPullRibbonIconEl.removeClass('animate-icon')
		});
		this.fitPullRibbonIconEl.addClass("fit-pull-ribbon-el")
		
		// Push local to remote
		this.fitPushRibbonIconEl = this.addRibbonIcon('github', 'Fit push', async (evt: MouseEvent) => {
			if (this.syncing || this.pulling || this.pushing) { return }
			this.fitPushRibbonIconEl.addClass('animate-icon')
			this.pushing = true
			const pushNotice = this.initializeFitNotice();
			const errorCaught = await this.catchErrorAndNotify(this.push, pushNotice);
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
			if (errorCaught === true) {
				this.removeFitNotice(pushNotice, "error")
				this.pushing = false
				return
			}
			this.removeFitNotice(pushNotice)
			this.pushing = false
			this.fitPushRibbonIconEl.removeClass('animate-icon')
		});
		this.fitPushRibbonIconEl.addClass('fit-push-ribbon-el');
		this.updateRibbonIcons();
	}


	async onload() {
		await this.loadSettings();
		await this.loadLocalStore();
		this.fit = new Fit(this.settings, this.localStore, this.app.vault)
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fitPull = new FitPull(this.fit, this.vaultOps)
		this.fitPush = new FitPush(this.fit, this.vaultOps)
		this.pulling = false
		this.pushing = false
		this.syncing = false
		this.loadRibbonIcons();

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// Command for computing an inputed file path's local sha for debugging purposes
		this.addCommand({
			id: 'compute-file-local-sha',
			name: 'Compute local sha for file (Debug)',
			callback: () => {
				new ComputeFileLocalShaModal(
					this.app, 
					async (queryFile) => console.log(await this.fit.computeFileLocalSha(queryFile))
				).open();
			}
		});

		// Command for computing an inputed file path's local sha for debugging purposes
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


		// Command for computing an inputed file path's local sha for debugging purposes
		this.addCommand({
			id: 'pull-file',
			name: 'Pull a file from remote for debugging purpose (Debug)',
			callback: async () => {
				const abc = new Notice(" ", 0) // keep at least one empty space to make the height consistent
				abc.noticeEl.addClass("fit-notice")
				setTimeout(() => abc.setMessage("Hello"), 3000)
				setTimeout(() => abc.setMessage("Hello\nabsdcadfasdfasfasdfasdfasfdsa\nsfgdasfgfafsdfads"), 3000)
				// abc.setMessage('124')
				new DebugModal(
					this.app, 
					async (debugInput) => {
						console.log(debugInput)
						console.log("Getting blob for ")
						const fileSha = this.localStore.lastFetchedRemoteSha[debugInput]
						const content = await this.fit.getBlob(fileSha)
						this.vaultOps.vault.createBinary('testing123.md', base64ToArrayBuffer(content))
						console.log(content)
					}
				).open();
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
					// new Notice("Remote update detected, please pull the latest changes.")
					console.log(`Remote updated, latest remote commit sha: ${updatedRemoteCommitSha}.`)
				} else {
					console.log(`Local copy up to date.`)
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
					if (key == "singleButtonMode") {
						obj[key] = Boolean(settings[key]);
					} else if (key == "checkEveryXMinutes") {
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
		this.updateRibbonIcons();
	}
}
