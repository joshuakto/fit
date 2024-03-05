import { Notice, Platform, Plugin, base64ToArrayBuffer } from 'obsidian';
import { ComputeFileLocalShaModal, DebugModal } from 'src/pluginModal';
import { Fit } from 'src/fit';
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
	verbose: boolean;
}

const DEFAULT_SETTINGS: FitSettings = {
	pat: "<Personal-Access-Token>",
	owner: "<Github-Username>",
	repo: "<Repository-Name>",
	branch: "main",
	deviceName: "",
	verbose: false
}

const DEFAULT_MOBILE_SETTINGS: FitSettings = {
	pat: "<Personal-Access-Token>",
	owner: "<Github-Username>",
	repo: "<Repository-Name>",
	branch: "main",
	deviceName: "",
	verbose: true
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
	fitPullRibbonIconEl: HTMLElement
	fitPushRibbonIconEl: HTMLElement
	
	

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
	


	async onload() {
		await this.loadSettings(Platform.isMobile);
		await this.loadLocalStore();
		this.fit = new Fit(this.settings, this.localStore, this.app.vault)
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fitPull = new FitPull(this.fit, this.vaultOps)
		this.fitPush = new FitPush(this.fit, this.vaultOps)

		// Pull remote to local
		this.fitPullRibbonIconEl = this.addRibbonIcon("github", 'Fit pull', async (evt: MouseEvent) => {
			this.verboseNotice("Performing pre pull checks.")
			this.fitPullRibbonIconEl.addClass('animate-icon')
			if (!this.checkSettingsConfigured()) { 
				this.fitPullRibbonIconEl.removeClass('animate-icon')
				return
			}
			await this.loadLocalStore()
			const checkResult = await this.fitPull.performPrePullChecks()
			if (!checkResult) {
				this.fitPullRibbonIconEl.removeClass('animate-icon')
				this.verboseNotice("Pre pull checks failed, aborting.")
				return
			}// early return to abort pull
			this.verboseNotice("Pre pull checks successful, pulling changes from remote.")
			await this.fitPull.pullRemoteToLocal(checkResult, this.saveLocalStoreCallback)
			new Notice("Pull complete, local copy up to date.")
			this.fitPullRibbonIconEl.removeClass('animate-icon')
		});

		this.fitPullRibbonIconEl.addClass("fit-pull-ribbon-el")
		

		// Push local to remote
		this.fitPushRibbonIconEl = this.addRibbonIcon('github', 'Fit push', async (evt: MouseEvent) => {
			this.verboseNotice("Performing pre push checks.")
			this.fitPushRibbonIconEl.addClass('animate-icon')
			if (!this.checkSettingsConfigured()) { 
				this.fitPushRibbonIconEl.removeClass('animate-icon')
				return
			}
			await this.loadLocalStore()
			const checksResult = await this.fitPush.performPrePushChecks()
			if (!checksResult) {
				this.fitPushRibbonIconEl.removeClass('animate-icon')
				this.verboseNotice("Pre push checks failed, aborting.")
				return
			} // early return if prepush checks not passed
			this.verboseNotice("Pre push checks successful, pushing local changes to remote.")
			await this.fitPush.pushChangedFilesToRemote(checksResult, this.saveLocalStoreCallback)
			this.fitPushRibbonIconEl.removeClass('animate-icon')
			new Notice(`Successful pushed to ${this.fit.repo}`)
		});
		
		// add class to ribbon element to afford styling, refer to styles.css
		this.fitPushRibbonIconEl.addClass('fit-push-ribbon-el');

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
			name: `Update local store with new local sha, essentially
			ignoring local changes when pulling/pushing (Dangerous:
				running pull after this command will discard local changes)`,
			callback: async () => {
				this.localStore.localSha = await this.fit.computeLocalSha()
				this.saveLocalStore()
				new Notice(`Local sha recomputed and stored, they will
				 not be considered in future push/pull.`)
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
					if (key == "verbose") {
						obj[key] = Boolean(settings["verbose"]);
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
