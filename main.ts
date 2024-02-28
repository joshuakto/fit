import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
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


export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
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

	async computeLocalSha(): Promise<{[k:string]:string}> {
		const paths = this.app.vault.getFiles().map(f=>f.path)
		return Object.fromEntries(
			await Promise.all(
				paths.map(async (p: string): Promise<[string, string]> =>{
					return [p, await this.fit.fileSha1(await this.app.vault.adapter.read(p))]
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
		return true
	}

	compareSha(remoteSha: {[k:string]:string}, lastFetchedRemoteSha: {[k:string]:string}): Array<{path: string, status: 'added' | 'removed' | 'changed'}> {
		const allPaths = Array.from(new Set([...Object.keys(remoteSha), ...Object.keys(lastFetchedRemoteSha)]));
	
		return allPaths.reduce<{path: string, status: 'added' | 'removed' | 'changed'}[]>((changes, path) => {
			const inRemote = path in remoteSha;
			const inLastFetched = path in lastFetchedRemoteSha;
	
			if (inRemote && !inLastFetched) {
				changes.push({ path, status: 'added' });
			} else if (!inRemote && inLastFetched) {
				changes.push({ path, status: 'removed' });
			} else if (inRemote && inLastFetched && remoteSha[path] !== lastFetchedRemoteSha[path]) {
				changes.push({ path, status: 'changed' });
			}
			// Unchanged files are implicitly handled by not adding them to the changes array
	
			return changes;
		}, []);
	}

	async onload() {
		await this.loadSettings();
		this.fit = new Fit(this.settings)

		// pull remote to local
		this.addRibbonIcon('github', 'Fit pull', async (evt: MouseEvent) => {
			if (!this.checkSettingsConfigured()) {
				return
			}
			// https://dev.to/lucis/how-to-push-files-programatically-to-a-repository-using-octokit-with-typescript-1nj0
			const {data: latestRemoteCommit} = await this.fit.getRef(`heads/${this.settings.branch}`)
			const latestRemoteCommitSha = latestRemoteCommit.object.sha;
			const pluginLocalStore = await this.loadData()
			if (latestRemoteCommitSha == pluginLocalStore.lastFetchedCommitSha) {
				new Notice("Local copy already up to date")
				return
			}
			
			// Since remote changes are detected, get the latest remote tree
			const { data: latestRemoteTree } = await this.fit.getTree(latestRemoteCommitSha)
			const remoteSha = Object.fromEntries(latestRemoteTree.tree.map((node) : [string, string] | null=>{
				// currently ignoreing directory changes
				if (node.type=="blob") {
					if (!node.path || !node.sha) {
						throw new Error("path and sha not found for blob node in remote");
					}
					return [node.path, node.sha]
				}
				return null
			}).filter(entry => entry!==null) as [string, string][])
			
			// TODO checked for changed files by iterating and comparing the remote sha
			let addToLocal: Record<string, string> = {};
			let deleteFromLocal: Array<string> = [];
			// if lastFetchedRemoteSha is not in local store yet, update every file
			if (!pluginLocalStore.lastFetchedRemoteSha) {
				const entries = await Promise.all(Object.entries(remoteSha).map(async (kv) => {
					const path = kv[0]
					const file_sha = kv[1]
					const {data} = await this.fit.getBlob(file_sha)
					const contentUtf8 = atob(data.content)
					return {[path]: contentUtf8}
				}))
				addToLocal = Object.assign({}, ...entries)
			} else {
				const remoteChanges = this.compareSha(remoteSha, pluginLocalStore.lastFetchedRemoteSha)
				await Promise.all(remoteChanges.map(async change => {
					if (["changed", "added"].includes(change.status)) {
						const {data} = await this.fit.getBlob(remoteSha[change.path])
						const decodedContent = atob(data.content);
						addToLocal = {...addToLocal, [change.path]: decodedContent}
					} else {
						deleteFromLocal = [...deleteFromLocal, change.path]
					}
				}))
			}

			// Update changed files locally TODO: need to check if there are clashing local changes, if so, prompt above for user confirmation before proceeding
			// const remoteBlob = await this.fit.octokit.rest.git.getBlob({
			// 	owner: this.fit.owner,
			// 	repo: this.fit.repo,
			// 	file_sha: remoteSha['test.md']
			// })
			// const decodedContent = atob(remoteBlob.data.content);
			// this.app.vault.create('test.md', decodedContent)
			// this.app.vault.modify()
			const filewriting = Object.entries(addToLocal).map(async entry=>{
				const path = entry[0]
				const content = entry[1]
				const file = this.app.vault.getFileByPath(path)
				if (file) {
					await this.app.vault.modify(file, content)
					return {path, type: "modification"}
				} else {
					await this.app.vault.create(path, content)
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
			pluginLocalStore.lastFetchedCommitSha = latestRemoteCommitSha
			this.saveData({...pluginLocalStore, lastFetchedRemoteSha: {...remoteSha}})
			fileOps.map(op=> new Notice(`${op.path} ${op.type} completed.`))
		});

		// push local to remote
		const ribbonIconEl = this.addRibbonIcon('github', 'Fit', async (evt: MouseEvent) => {
			const pluginLocalStore = await this.loadData()
			// if (pluginLocalStore.latestCommitTreeSha && pluginLocalStore.latestCommitTreeSha !=)
			if (!this.checkSettingsConfigured()) {
				return
			}
			const owner = this.settings.owner
			const repo = this.settings.repo
			// https://dev.to/lucis/how-to-push-files-programatically-to-a-repository-using-octokit-with-typescript-1nj0
			const {data: latestRef} = await this.fit.getRef(`heads/${this.settings.branch}`)
			const latestRemoteCommitSha = latestRef.object.sha;
			if (latestRemoteCommitSha != pluginLocalStore.lastFetchedCommitSha) {
				new Notice("Remote changed after last pull/write, please pull again.")
				return
			}
			const {data: latestCommit} = await this.fit.getCommit(latestRemoteCommitSha)
			
			const files = this.app.vault.getFiles()
			const localSha = await this.computeLocalSha()

			let changedFiles: Array<{path: string, type: string, extension?: string}>;
			if (pluginLocalStore.localSha) {
				changedFiles = files.flatMap((f: TFile) => {
					if (!(Object.keys(pluginLocalStore.localSha).includes(f.path))) {
						return { path: f.path, type: 'created', extension: f.extension };
					} else if (localSha[f.path] !== pluginLocalStore.localSha[f.path]) {
						return { path: f.path, type: 'changed', extension: f.extension };
					}
					return []
				});
			} else {
				// mark all files as changed if no local sha for previous commit is found
				changedFiles = files.map(f=> {return {
					path: f.path, type: 'changed', extension: f.extension}})
			}
			const { data: latestRemoteTree } = await this.fit.getTree(latestRemoteCommitSha)
			const removedFiles:Array<{path: string, type: string}>  = latestRemoteTree.tree.flatMap(node=> {
				if(!(node.type == "tree") && node.path && !Object.keys(localSha).includes(node.path)) {
					return {path: node.path, type: 'deleted'}
				}
				return []
			})
			changedFiles.push(...removedFiles)
			if (changedFiles.length == 0) {
				new Notice("No local changes detected.")
				return
			}

			const treeNodes = await Promise.all(changedFiles.map((f) => {
				return this.createTreeNodeFromFile(f)
			}))

			const newTree = await this.fit.createTree(treeNodes, latestCommit.tree.sha)
			const message = `Commit from ${this.settings.deviceName} on ${new Date().toLocaleString()}`
			const {data: newCommit} = await this.fit.octokit.rest.git.createCommit({
				owner, repo, message,
				tree: newTree.data.sha,
				parents: [latestRemoteCommitSha]
			})
			await this.fit.updateRef(`heads/${this.settings.branch}`, newCommit.sha)
			await this.saveData({...this.settings, localSha: {...localSha}, lastFetchedCommitSha: newCommit.sha})
			new Notice(`Successful pushed to ${this.settings.repo} (${message})`)
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
				new SampleModal(this.app).open();
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
						new SampleModal(this.app).open();
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
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
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
