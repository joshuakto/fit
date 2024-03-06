import { Notice, Platform, Plugin, base64ToArrayBuffer } from 'obsidian';
import { ComputeFileLocalShaModal, DebugModal } from 'src/pluginModal';
import { Fit } from 'src/fit';
import { FitPull, RemoteUpdate } from 'src/fitPull';
import { FitPush } from 'src/fitPush';
import FitSettingTab from 'src/fitSetting';
import { VaultOperations } from 'src/vaultOps';


export interface FitSettings {
	pat: string;
	owner: string;
	repo: string;
	branch: string;
	deviceName: string;
	verbose: boolean;
	singleButtonMode: boolean
}

const DEFAULT_SETTINGS: FitSettings = {
	pat: "<Personal-Access-Token>",
	owner: "<Github-Username>",
	repo: "<Repository-Name>",
	branch: "main",
	deviceName: "",
	verbose: false,
	singleButtonMode: false
}

const DEFAULT_MOBILE_SETTINGS: FitSettings = {
	pat: "<Personal-Access-Token>",
	owner: "<Github-Username>",
	repo: "<Repository-Name>",
	branch: "main",
	deviceName: "",
	verbose: true,
	singleButtonMode: false
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
	fitPullRibbonIconEl: HTMLElement
	fitPushRibbonIconEl: HTMLElement
	fitSyncRibbonIconEl: HTMLElement
	
	

	checkSettingsConfigured(): boolean {
		if (["<Personal-Access-Token> ", ""].includes(this.settings.pat)) {
			new Notice("Please provide git personal access tokens in Fit settings and try again.")
			return false
		}
		if (["<Github-Username>", ""].includes(this.settings.owner)) {
			new Notice("Please provide git repo owner in Fit settings and try again.")
			return false
		}
		if (["<Repository-Name>", ""].includes(this.settings.repo)) {
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

	verboseNotice(message: string): void {
		if (this.settings.verbose) {
			new Notice(message)
		}
	}

	async fetch(): Promise<RemoteUpdate | null> {
		if (!this.checkSettingsConfigured()) { 
			return null
		}
		await this.loadLocalStore()
		return await this.fitPull.performPrePullChecks()
	}

	async pull(): Promise<void> {
		if (this.pulling) {
			return
		}
		this.pulling = true
		this.verboseNotice("Performing pre pull checks.")
		const remoteUpdate = await this.fetch()
		if (!remoteUpdate) {
			this.pulling = false
			return
		}
		// early return to abort pull
		this.verboseNotice("Pre pull checks successful, pulling changes from remote.")
		await this.fitPull.pullRemoteToLocal(remoteUpdate, this.saveLocalStoreCallback)
		new Notice("Pull complete, local copy up to date.")
		this.pulling = false
	}

	async push(): Promise<void> {
		if (this.pushing) {
			return
		}
		this.pushing = true
		this.verboseNotice("Performing pre push checks.")
		if (!this.checkSettingsConfigured()) { 
			this.pushing = false
			return
		}
		await this.loadLocalStore()
		const checksResult = await this.fitPush.performPrePushChecks()
		if (!checksResult) {
			this.pushing = false
			return
		} // early return if prepush checks not passed
		this.verboseNotice("Pre push checks successful, pushing local changes to remote.")
		await this.fitPush.pushChangedFilesToRemote(checksResult, this.saveLocalStoreCallback)
		new Notice(`Successful pushed to ${this.fit.repo}`)
		this.pushing = false
	}

	async sync(): Promise<void> {
		// // Note: this is a placeholder only, it is not a ready feature
		// // TODO: sync requires a different order of running checks, to minimize the possibilities of aborting after changes
		// // Ideally, sync should undo changes if it needs to abort
		// // Current implementation will only ever pull since pulling will update localSha and local changes will not be detected during push
		// // This feature will be developed as push and pull separately becomes mature
		// const fetchedRemoteChanges = await this.fetch()
		// // TODO get more info from fetched remote changes and process them before pushing
		// console.log(fetchedRemoteChanges)
		// await this.push()
		// new Notice("Sync complete.")
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
	


	async onload() {
		await this.loadSettings(Platform.isMobile);
		await this.loadLocalStore();
		this.fit = new Fit(this.settings, this.localStore, this.app.vault)
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fitPull = new FitPull(this.fit, this.vaultOps)
		this.fitPush = new FitPush(this.fit, this.vaultOps)
		this.pulling = false
		this.pushing = false

		// Pull from remote then Push to remote if no clashing changes detected during pull
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Fit Sync', async (evt: MouseEvent) => {
			this.fitSyncRibbonIconEl.addClass('animate-icon');
			await new Promise(resolve => setTimeout(resolve, 3000));
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
		});
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
		
		// Pull remote to local
		this.fitPullRibbonIconEl = this.addRibbonIcon("github", 'Fit pull', async (evt: MouseEvent) => {
			this.fitPullRibbonIconEl.addClass('animate-icon')
			await this.pull();
			this.fitPullRibbonIconEl.removeClass('animate-icon')
		});
		this.fitPullRibbonIconEl.addClass("fit-pull-ribbon-el")
		
		// Push local to remote
		this.fitPushRibbonIconEl = this.addRibbonIcon('github', 'Fit push', async (evt: MouseEvent) => {
			this.fitPushRibbonIconEl.addClass('animate-icon')
			await this.push();
			this.fitPushRibbonIconEl.removeClass('animate-icon')
		});
		this.fitPushRibbonIconEl.addClass('fit-push-ribbon-el');

		if (this.settings.singleButtonMode) {
			this.fitSyncRibbonIconEl.removeClass("hide");
		} else {
			this.fitSyncRibbonIconEl.addClass("hide");
		}

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
					console.log(`Remote updated, latest remote commit sha: ${updatedRemoteCommitSha}.`)
				} else {
					console.log(`Local copy up to date.`)
				}
			}
		}, 5 * 60 * 1000));
	}

	onunload() {}

	async loadSettings(isMobile?: boolean) {
		const userSetting = await this.loadData()
		let settings = Object.assign({}, DEFAULT_SETTINGS, userSetting);
		if (isMobile && !userSetting) {
			settings = Object.assign({}, DEFAULT_MOBILE_SETTINGS);
		}
		const settingsObj: FitSettings = Object.keys(DEFAULT_SETTINGS).reduce(
			(obj, key: keyof FitSettings) => {
				if (settings.hasOwnProperty(key)) {
					if (key == "verbose" || key == "singleButtonMode") {
						obj[key] = Boolean(settings[key]);
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
