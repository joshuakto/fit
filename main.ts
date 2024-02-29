import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { warn } from 'console';
import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { Add } from 'src/add';
import { Fit } from 'src/fit';

// Remember to rename these classes and interfaces!

export interface MyPluginSettings {
	pat: string;
	owner: string;
	repo: string;
	branch: string;
	deviceName: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	pat: "<Personal-Access-Token>",
	owner: "<Github-Username>",
	repo: "<Repository-Name>",
	branch: "main",
	deviceName: "",
}

interface LocalStores {
	localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
}

const DEFAULT_LOCAL_STORE: LocalStores = {
	localSha: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteSha: {}
}

function base64ToArrayBuffer(base64String: string): ArrayBuffer {
	const binaryString = atob(base64String);
	const len = binaryString.length;
	const bytes = new Uint8Array(len)
	for (let i = 0; i < len; i++) {
		bytes[i] = binaryString.charCodeAt(i)
	}
	return bytes.buffer
}


export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	localStore: LocalStores
	fit: Fit;
	add = new Add(this.app.vault.adapter)
	
	async createTreeNodeFromFile(
		{path, type, extension}: {path: string, type: string, extension?: string}): 
		Promise<RestEndpointMethodTypes["git"]["createTree"]["parameters"]["tree"][number]> {
		if (type === "deleted") {
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null
			}
		}
		let encoding: string;
		let content: string 
		if (extension && ["pdf", "png", "jpeg"].includes(extension)) {
			encoding = "base64"
			const fileArrayBuf = await this.app.vault.adapter.readBinary(path)
			const uint8Array = new Uint8Array(fileArrayBuf);
			let binaryString = '';
			for (let i = 0; i < uint8Array.length; i++) {
				binaryString += String.fromCharCode(uint8Array[i]);
			}
			content = btoa(binaryString);
		} else {
			encoding = 'utf-8'
			content = await this.app.vault.adapter.read(path)
		}
		// temp function of stageFile: check if file exists in vault data adapter
		const fileExists = this.add.stageFile(path)
		if (!fileExists) {
			throw new Error("Unexpected error: attempting to createBlob for non-existent file, please file an issue on github with info to reproduce the issue.");
		}
		const blob = await this.fit.octokit.rest.git.createBlob({
			owner: this.settings.owner,
			repo: this.settings.repo,
			content, encoding
		})
		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blob.data.sha
		}
	}

	async computeFileLocalSha(path: string): Promise<string> {
		const localFile = await this.app.vault.adapter.read(path)
		if (!localFile) {
			throw new Error(`Attempting to compute local sha for ${path}, but file not found.`);
		}
		return await this.fit.fileSha1(localFile)
	}

	async computeLocalSha(): Promise<{[k:string]:string}> {
		const paths = this.app.vault.getFiles().map(f=>f.path)
		return Object.fromEntries(
			await Promise.all(
				paths.map(async (p: string): Promise<[string, string]> =>{
					return [p, await this.computeFileLocalSha(p)]
				})
			)
		)
	}

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
		this.fit.refreshSetting(this.settings)
		return true
	}

	// compare currentSha with storedSha and check for differences, files only in currentSha are considerd added, while files only in storedSha are considered removed
	compareSha(currentSha: {[k:string]:string}, storedSha: {[k:string]:string}): Array<{path: string, status: 'added' | 'removed' | 'changed'}> {
		const allPaths = Array.from(new Set([...Object.keys(currentSha), ...Object.keys(storedSha)]));
	
		return allPaths.reduce<{path: string, status: 'added' | 'removed' | 'changed'}[]>((changes, path) => {
			const inCurrent = path in currentSha;
			const inStored = path in storedSha;
	
			if (inCurrent && !inStored) {
				changes.push({ path, status: 'added' });
			} else if (!inCurrent && inStored) {
				changes.push({ path, status: 'removed' });
			} else if (inCurrent && inStored && currentSha[path] !== storedSha[path]) {
				changes.push({ path, status: 'changed' });
			}
			// Unchanged files are implicitly handled by not adding them to the changes array
			return changes;
		}, []);
	}

	async onload() {
		await this.loadSettings();
		this.fit = new Fit(this.settings, this.app.vault)

		// pull remote to local
		this.addRibbonIcon('github', 'Fit pull', async (evt: MouseEvent) => {
			if (!this.checkSettingsConfigured()) {
				return
			}
			await this.loadLocalStore()
			const realtimeLocalSha = await this.computeLocalSha();
			const localChanges = this.compareSha(realtimeLocalSha, this.localStore.localSha)
			const {data: latestRemoteCommit} = await this.fit.getRef(`heads/${this.settings.branch}`)
			const latestRemoteCommitSha = latestRemoteCommit.object.sha;
			if (latestRemoteCommitSha == this.localStore.lastFetchedCommitSha) {
				new Notice("Local copy already up to date")
				return
			}
			// Since remote changes are detected, get the latest remote tree
			const { data: latestRemoteTree } = await this.fit.getTree(latestRemoteCommitSha)
			const remoteSha = Object.fromEntries(latestRemoteTree.tree.map((node) : [string, string] | null=>{
				// currently ignoreing directory changes
				if (node.type=="blob") {
					if (!node.path || !node.sha) {
						throw new Error("Path and sha not found for blob node in remote");
					}
					return [node.path, node.sha]
				}
				return null
			}).filter(Boolean) as [string, string][])
			
			let addToLocal: Record<string, {content: string, enc: string}> = {};
			let deleteFromLocal: Array<string> = [];
			// if lastFetchedCommitSha is not in local store yet, update every file
			if (!this.localStore.lastFetchedCommitSha) {
				if (localChanges.length > 0){
					// TODO allow user to act on this notice
					new Notice("Unsaved local changes detected, aborting remote file dump.")
					console.log(localChanges)
				}
				const entries = await Promise.all(Object.entries(remoteSha).map(async (kv) => {
					const path = kv[0]
					const file_sha = kv[1]
					const extension = path.match(/[^.]+$/)?.[0];
					const {data} = await this.fit.getBlob(file_sha)
					// if file type is in the following list, keep as base64 encoding
					if (extension && ["png", "jpeg", "pdf"].includes(extension)) {
						return {[path]: {content: data.content, enc: "base64"}}
					}
					const contentUtf8 = atob(data.content)
					return {[path]: {content: contentUtf8, enc: "utf-8"}}
				}))
				addToLocal = Object.assign({}, ...entries)
			} else {
				const remoteChanges = this.compareSha(remoteSha, this.localStore.lastFetchedRemoteSha)
				const localChangePaths = localChanges.map(c=>c.path)
				const clashedChanges = remoteChanges.map(change => {
					if (localChangePaths.includes(change.path)) {
						return change.path
					}
				}).filter(Boolean) as string[]
				if (remoteChanges.some(change => localChangePaths.includes(change.path))){
					// TODO allow user to act on this notice
					// TODO investigate why localSha computed is different
					console.log("DEBUG HERE")
					console.log(localChanges)
					console.log(realtimeLocalSha)
					console.log(this.localStore.localSha)
					new Notice("Unsaved local changes clashes with remote changes, aborting.")
					clashedChanges.map(clash => console.log(`Clashing file: ${clash}`))
					return
				}
				await Promise.all(remoteChanges.map(async change => {
					if (["changed", "added"].includes(change.status)) {
						const extension = change.path.match(/[^.]+$/)?.[0];
						const {data} = await this.fit.getBlob(remoteSha[change.path])
						if (extension && ["png", "jpeg", "pdf"].includes(extension)) {
							// if file type is in the above list, keep as base64 encoding
							addToLocal = {...addToLocal, [change.path]: {content: data.content, enc: "base64"}}
						} else {
							const decodedContent = atob(data.content);
							addToLocal = {...addToLocal, [change.path]: {content: decodedContent, enc: "utf-8"}}
						}
					} else {
						deleteFromLocal = [...deleteFromLocal, change.path]
					}
				}))
				new Notice("Pull complete, local copy up to date.")
			}

			// Update changed files locally TODO: need to check if there are clashing local changes, if so, prompt above for user confirmation before proceeding
			const filewriting = Object.entries(addToLocal).map(async entry=>{
				const path = entry[0]
				const {content, enc} = entry[1]
				const file = this.app.vault.getFileByPath(path)
				if (file) {
					if (enc == "utf-8") {
						await this.app.vault.modify(file, content)
					} else if (enc == "base64") {
						await this.app.vault.modifyBinary(file, base64ToArrayBuffer(content))
					}
					return {path, type: "modification"}
				} else {
					if (enc == "utf-8") {
						await this.app.vault.create(path, content)
					} else if (enc == "base64") {
						await this.app.vault.createBinary(path, base64ToArrayBuffer(content))
					}
					return {path, type: "creation"}
				}
			})
			const deletion = deleteFromLocal.map(async f=> {
				const file = this.app.vault.getFileByPath(f)
				if (file) { 
					await this.app.vault.delete(file)
					return {path: file.path, type: "deletion"}
				}
			}).filter(Boolean) as Promise<{path: string, type: string}>[]
			const fileOps = await Promise.all([...filewriting, ...deletion])
			this.localStore.lastFetchedCommitSha = latestRemoteCommitSha
			this.localStore.lastFetchedRemoteSha = remoteSha
			this.localStore.localSha = await this.computeLocalSha()
			await this.saveLocalStore()
			fileOps.map(op=> new Notice(`${op.path} ${op.type} completed.`))
		});

		// for debugging
		this.addRibbonIcon('github', 'Update Local Store (Debug)', async (evt: MouseEvent) => {
			await this.loadLocalStore()
			const {data: latestRemoteCommit} = await this.fit.getRef(`heads/${this.settings.branch}`)
			const latestRemoteCommitSha = latestRemoteCommit.object.sha;
			// Since remote changes are detected, get the latest remote tree
			const { data: latestRemoteTree } = await this.fit.getTree(latestRemoteCommitSha)
			const remoteSha = Object.fromEntries(latestRemoteTree.tree.map((node) : [string, string] | null=>{
				// currently ignoreing directory changes
				if (node.type=="blob") {
					if (!node.path || !node.sha) {
						throw new Error("Path and sha not found for blob node in remote");
					}
					return [node.path, node.sha]
				}
				return null
			}).filter(Boolean) as [string, string][])
			this.localStore.localSha = await this.computeLocalSha()
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
			if (latestRemoteCommitSha != this.localStore.lastFetchedCommitSha) {
				new Notice("Remote changed after last pull/write, please pull again.")
				return
			}
			const {data: latestCommit} = await this.fit.getCommit(latestRemoteCommitSha)
			
			const files = this.app.vault.getFiles()
			const localSha = await this.computeLocalSha()

			let changedFiles: Array<{path: string, type: string, extension?: string}>;
			// mark all files as changed if local sha for previous commit is not found
			if (!this.localStore.localSha) {
				changedFiles = files.map(f=> {return {
					path: f.path, type: 'changed', extension: f.extension}})
			} else {
				const localChanges = this.compareSha(localSha, this.localStore.localSha)
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
				return this.createTreeNodeFromFile(f)
			}))

			const {data: newTree} = await this.fit.createTree(treeNodes, latestCommit.tree.sha)
			const {data: newCommit} = await this.fit.createCommit(newTree.sha, latestRemoteCommitSha)
			await this.fit.updateRef(`heads/${this.settings.branch}`, newCommit.sha)
			await this.saveData({...this.settings, localSha, lastFetchedCommitSha: newCommit.sha})
			new Notice(`Successful pushed to ${this.settings.repo}`)
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new ComputeFileLocalShaModal(
					this.app, 
					async (queryFile) => console.log(await this.computeFileLocalSha(queryFile))
				).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new ComputeFileLocalShaModal(
							this.app, 
							async (queryFile) => console.log(await this.computeFileLocalSha(queryFile))
						).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		// for debugging
		this.addRibbonIcon('combine', 'Debug', async (evt: MouseEvent) => {
			this.loadLocalStore()
			console.log("localSha")
			console.log(this.localStore.localSha)
			console.log("computedLocalSha")
			console.log(await this.computeLocalSha())
		})
	}

	onunload() {

	}

	async loadSettings() {
		const settings = await this.loadData();
		const relevantSettings: MyPluginSettings = Object.keys(DEFAULT_SETTINGS).reduce((obj, key: keyof MyPluginSettings) => {
			if (settings.hasOwnProperty(key)) {
				obj[key] = settings[key];
			}
			obj[key] = settings[key];
			return obj;
		}, {} as MyPluginSettings);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, relevantSettings);
	}

	async loadLocalStore() {
		const localStore = await this.loadData()
		const relevantStore: LocalStores = Object.keys(DEFAULT_LOCAL_STORE).reduce((obj, key: keyof LocalStores) => {
			if (localStore.hasOwnProperty(key)) {
				obj[key] = localStore[key];
			}
			return obj;
		}, {} as LocalStores);
		this.localStore = Object.assign({}, DEFAULT_LOCAL_STORE, relevantStore)
	}

	// allow saving of local stores property, passed in properties will override existing stored value
	async saveLocalStore() {
		const data = await this.loadData()
		await this.saveData({...data, ...this.localStore})
	}

	async saveSettings() {
		const data = await this.loadData()
		await this.saveData({...data, ...this.settings});
	}
}

class ComputeFileLocalShaModal extends Modal {
	queryFile: string;
	onSubmit: (result: string) => void;

	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.createEl("h1", { text: "Input the filename you want to compute local Sha for:" });
		new Setting(contentEl)
		.setName("Name")
		.addText((text) =>
			text.onChange((value) => {
			this.queryFile = value
			}));

		new Setting(contentEl)
		.addButton((btn) =>
			btn
			.setButtonText("Submit")
			.setCta()
			.onClick(() => {
				this.close();
				this.onSubmit(this.queryFile);
			}));
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Github Personal Access Token')
			.setDesc('Remember to give it the appropriate access for reading and writing to the storage repo.')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.pat)
				.onChange(async (value) => {
					this.plugin.settings.pat = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Github Username')
			.setDesc('Your Github handle.')
			.addText(text => text
				.setPlaceholder('Enter your username')
				.setValue(this.plugin.settings.owner)
				.onChange(async (value) => {
					this.plugin.settings.owner = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Github Repository Name')
			.setDesc('The repo you dedicate to tracking this vault.')
			.addText(text => text
				.setPlaceholder('Enter your repository name')
				.setValue(this.plugin.settings.repo)
				.onChange(async (value) => {
					this.plugin.settings.repo = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Branch Name')
			.setDesc('The branch name you set to push to (default to main)')
			.addText(text => text
				.setPlaceholder('Enter the branch name')
				.setValue(this.plugin.settings.branch)
				.onChange(async (value) => {
					this.plugin.settings.branch = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Device Name')
			.setDesc('The name of this device, used to decorate commit message')
			.addText(text => text
				.setPlaceholder('Enter device name')
				.setValue(this.plugin.settings.deviceName)
				.onChange(async (value) => {
					this.plugin.settings.deviceName = value;
					await this.plugin.saveSettings();
				}));
	}
}
