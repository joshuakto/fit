import { Notice, Plugin } from 'obsidian';
import { ComputeFileLocalShaModal } from 'pluginModal';
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
}

const DEFAULT_SETTINGS: FitSettings = {
	pat: "<Personal-Access-Token>",
	owner: "<Github-Username>",
	repo: "<Repository-Name>",
	branch: "main",
	deviceName: "",
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
	


	async onload() {
		await this.loadSettings();
		await this.loadLocalStore();
		this.fit = new Fit(this.settings, this.localStore, this.app.vault)
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fitPull = new FitPull(this.fit, this.vaultOps)
		this.fitPush = new FitPush(this.fit, this.vaultOps)

		// Pull remote to local
		this.addRibbonIcon('github', 'Fit pull', async (evt: MouseEvent) => {
			if (!this.checkSettingsConfigured()) { return }
			await this.loadLocalStore()
			const checkResult = await this.fitPull.performPrePullChecks()
			if (!checkResult) {return }// early return to abort pull
			await this.fitPull.pullRemoteToLocal(...[...checkResult, this.saveLocalStoreCallback])
		});

		// Push local to remote
		const ribbonIconEl = this.addRibbonIcon('github', 'Fit push', async (evt: MouseEvent) => {
			if (!this.checkSettingsConfigured()) { return }
			await this.loadLocalStore()
			const checksResult = await this.fitPush.performPrePushChecks()
			if (!checksResult) {return} // early return if prepush checks not passed
			const [changedFiles, latestRemoteCommitSha] = checksResult
			await this.fitPush.pushChangedFilesToRemote(
				changedFiles, latestRemoteCommitSha, this.saveLocalStoreCallback)
		});
		
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
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

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new FitSettingTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		// for debugging
		this.addRibbonIcon('github', 'Update Local Store (Debug)', async (evt: MouseEvent) => {
			await this.loadLocalStore()
			const latestRemoteCommitSha = await this.fit.getLatestRemoteCommitSha()
			// Since remote changes are detected, get the latest remote tree
			const remoteSha = await this.fit.getRemoteTreeSha(latestRemoteCommitSha)
			this.localStore.localSha = await this.fit.computeLocalSha()
			this.localStore.lastFetchedRemoteSha = remoteSha
			this.localStore.lastFetchedCommitSha = latestRemoteCommitSha
			await this.saveLocalStore()
		})
	}

	onunload() {}

	async loadSettings() {
		const settings = await this.loadData();
		const  settingsObj: FitSettings = Object.keys(DEFAULT_SETTINGS).reduce((obj, key: keyof FitSettings) => {
			if (settings.hasOwnProperty(key)) {
				obj[key] = settings[key];
			}
			return obj;
		}, {} as FitSettings);
		this.settings = settingsObj
	}

	async loadLocalStore() {
		const localStore = await this.loadData()
		const localStoreObj: LocalStores = Object.keys(DEFAULT_LOCAL_STORE).reduce((obj, key: keyof LocalStores) => {
			if (localStore.hasOwnProperty(key)) {
				obj[key] = localStore[key];
			}
			return obj;
		}, {} as LocalStores);
		this.localStore = localStoreObj
	}

	// allow saving of local stores property, passed in properties will override existing stored value
	async saveLocalStore() {
		const data = await this.loadData()
		await this.saveData({...data, ...this.localStore})
		// sync local store to Fit class as well upon saving
		this.fit.loadLocalStore(this.localStore)
	}

	async saveSettings() {
		const data = await this.loadData()
		await this.saveData({...data, ...this.settings});
		// sync settings to Fit class as well upon saving
		this.fit.loadSettings(this.settings)
	}
}
