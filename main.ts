import { warn } from 'console';
import { Notice, Plugin } from 'obsidian';
import { ComputeFileLocalShaModal } from 'pluginModal';
import { Fit } from 'src/fit';
import { FitPull } from 'src/fitPull';
import { FitPush } from 'src/fitPush';
import FitSettingTab from 'src/fitSetting';
import { compareSha } from 'src/utils';
import { VaultOperations } from 'src/vaultOps';

// Remember to rename these classes and interfaces!

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
	


	async onload() {
		await this.loadSettings();
		await this.loadLocalStore();
		this.fit = new Fit(this.settings, this.localStore, this.app.vault)
		this.vaultOps = new VaultOperations(this.app.vault)
		this.fitPull = new FitPull(this.fit, this.vaultOps)
		this.fitPush = new FitPush(this.fit, this.vaultOps)

		// pull remote to local
		this.addRibbonIcon('github', 'Fit pull', async (evt: MouseEvent) => {
			if (!this.checkSettingsConfigured()) {
				return
			}
			await this.loadLocalStore()
			const realtimeLocalSha = await this.fit.computeLocalSha();
			const localChanges = compareSha(realtimeLocalSha, this.localStore.localSha)
			const {data: latestRemoteCommit} = await this.fit.getRef(`heads/${this.settings.branch}`)
			const latestRemoteCommitSha = latestRemoteCommit.object.sha;
			if (latestRemoteCommitSha == this.localStore.lastFetchedCommitSha) {
				new Notice("Local copy already up to date")
				return
			}
			// Since remote changes are detected, get the latest remote tree
			const remoteSha = await this.fit.getRemoteTreeSha(latestRemoteCommitSha)
			
			let addToLocal: Array<{path: string, content: string, encoding: string}> = [];
			const deleteFromLocal: Array<string> = [];

			if (!this.localStore.lastFetchedCommitSha) {
				if (localChanges.length > 0) {
					new Notice("Unsaved local changes detected, aborting remote file dump.");

					console.log(localChanges);
				}
				addToLocal = await this.fitPull.getRemoteNonDeletionChanges(remoteSha);
			} else {
				const remoteChanges = compareSha(remoteSha, this.localStore.lastFetchedRemoteSha);
				const localChangePaths = localChanges.map(c => c.path);
				const clashedChanges = remoteChanges.filter(change => localChangePaths.includes(change.path)).map(change => change.path);

				if (clashedChanges.length > 0) {
					new Notice("Unsaved local changes clash with remote changes, aborting.");
					clashedChanges.forEach(clash => console.log(`Clashing file: ${clash}`));
					return;
				}

				const changesToProcess = remoteChanges.reduce((acc, change) => {
					if (["changed", "added"].includes(change.status)) {
						acc[change.path] = remoteSha[change.path];
					} else if (change.status === "removed") {
						deleteFromLocal.push(change.path);
					}
					return acc;
				}, {} as Record<string, string>);

				addToLocal = await this.fitPull.getRemoteNonDeletionChanges(changesToProcess)
			}
			
			// TODO: when there are clashing local changes, prompt user for confirmation before proceeding
			// TODO fix bug (Attempting to computeSha for local file but not found) [likely becasue delete operation already done but path still in localStore.localSha]
			await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal);
			this.localStore.lastFetchedCommitSha = latestRemoteCommitSha
			this.localStore.lastFetchedRemoteSha = remoteSha
			this.localStore.localSha = await this.fit.computeLocalSha()
			await this.saveLocalStore()
			new Notice("Pull complete, local copy up to date.")
		});

		// for debugging
		this.addRibbonIcon('github', 'Update Local Store (Debug)', async (evt: MouseEvent) => {
			await this.loadLocalStore()
			const {data: latestRemoteCommit} = await this.fit.getRef(`heads/${this.settings.branch}`)
			const latestRemoteCommitSha = latestRemoteCommit.object.sha;
			// Since remote changes are detected, get the latest remote tree
			const remoteSha = await this.fit.getRemoteTreeSha(latestRemoteCommitSha)
			this.localStore.localSha = await this.fit.computeLocalSha()
			this.localStore.lastFetchedRemoteSha = remoteSha
			this.localStore.lastFetchedCommitSha = latestRemoteCommitSha
			await this.saveLocalStore()
		})

		// push local to remote
		const ribbonIconEl = this.addRibbonIcon('github', 'Fit', async (evt: MouseEvent) => {
			if (!this.checkSettingsConfigured()) {
				return
			}
			await this.loadLocalStore()
			// https://dev.to/lucis/how-to-push-files-programatically-to-a-repository-using-octokit-with-typescript-1nj0
			const {data: latestRef} = await this.fit.getRef(`heads/${this.settings.branch}`)
			const latestRemoteCommitSha = latestRef.object.sha;
			if (!await this.fitPush.performPrePushChecks()) {
				// TODO incoporate more checks into the above func
				return
			}
			// if (latestRemoteCommitSha != this.localStore.lastFetchedCommitSha) {
			// 	new Notice("Remote changed after last pull/write, please pull again.")
			// 	return
			// }
			const {data: latestCommit} = await this.fit.getCommit(latestRemoteCommitSha)
			
			const files = this.app.vault.getFiles()
			const localSha = await this.fit.computeLocalSha()

			let changedFiles: Array<{path: string, type: string, extension?: string}>;
			// mark all files as changed if local sha for previous commit is not found
			if (!this.localStore.localSha) {
				changedFiles = files.map(f=> {return {
					path: f.path, type: 'changed', extension: f.extension}})
			} else {
				const localChanges = compareSha(localSha, this.localStore.localSha)
				changedFiles = localChanges.flatMap(change=>{
					if (change.status == "removed") {
						return {path: change.path, type: 'deleted'}
					} else {
						const file = this.app.vault.getFileByPath(change.path)
						if (!file) {
							warn(`${file} included in local changes (added/modified) but not found`)
							return []
						}
						if (change.status == "added") {
							return {path: change.path, type: 'created', extension: file.extension}
						} else {
							return {path: change.path, type: 'changed', extension: file.extension}
						}
					}
				})
			}
			if (changedFiles.length == 0) {
				new Notice("No local changes detected.")
				return
			}

			const treeNodes = await Promise.all(changedFiles.map((f) => {
				return this.fit.createTreeNodeFromFile(f)
			}))

			const {data: newTree} = await this.fit.createTree(treeNodes, latestCommit.tree.sha)
			const {data: newCommit} = await this.fit.createCommit(newTree.sha, latestRemoteCommitSha)
			const {data: updatedRef} = await this.fit.updateRef(`heads/${this.settings.branch}`, newCommit.sha)
			const updatedRemoteSha = await this.fit.getRemoteTreeSha(updatedRef.object.sha)
			this.localStore.localSha = localSha
			this.localStore.lastFetchedCommitSha = newCommit.sha
			this.localStore.lastFetchedRemoteSha = updatedRemoteSha
			this.saveLocalStore()
			// await this.saveData({...this.settings, localSha, lastFetchedCommitSha: newCommit.sha})
			new Notice(`Successful pushed to ${this.settings.repo}`)
			changedFiles.map(({path, type}): void=>{
				const typeToAction = {deleted: "deleted from", created: "added to", changed: "modified on"}
				new Notice(`${path} ${typeToAction[type as keyof typeof typeToAction]} remote.`, 10000)
			})
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
		this.addRibbonIcon('combine', 'Debug', async (evt: MouseEvent) => {
			this.loadLocalStore()
			console.log("localSha")
			console.log(this.localStore.localSha)
			console.log("computedLocalSha")
			console.log(await this.fit.computeLocalSha())
		})
	}

	onunload() {

	}

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
