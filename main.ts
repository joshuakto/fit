import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { Add } from 'src/add';
import { Commit } from 'src/commit';
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
	deviceName: ""
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	fit: Fit;
	commit = new Commit("Hello")
	add = new Add(this.app.vault.adapter)
	
	async onload() {
		await this.loadSettings();
		this.fit = new Fit("testRepo", this.settings)

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', async (evt: MouseEvent) => {
			if (this.settings.pat === "<Personal-Access-Token>") {
				new Notice("Please provide git personal access tokens in Fit settings and try again.")
				return
			}
			if (this.settings.owner === "<Github-Username>") {
				new Notice("Please provide git repo owner in Fit settings and try again.")
				return
			}
			if (this.settings.repo === "<Repository-Name>") {
				this.settings.repo = `obsidian-${this.app.vault.getName()}-storage`
			}
			// const fileExist = await this.add.stageFile('mountFuji.jpeg')
			// new Notice(this.settings.pat);
			// new Notice(String(this.fit.auth));
			// const gitAuth = await this.fit.octokit.rest.users.getAuthenticated();
			// Called when the user clicks the icon.
			// new Notice(this.commit.id)
			// new Notice(String(fileExist))
			// new Notice(String(gitAuth.data.id))
			// const repos = await this.fit.octokit.rest.repos.get(
			// 	{owner: 'joshuakto', repo: 'life-vault'}
			// )
			// new Notice(String(repos.data.commits_url))
			// https://dev.to/lucis/how-to-push-files-programatically-to-a-repository-using-octokit-with-typescript-1nj0
			const latestCommit = await this.fit.octokit.rest.git.getRef({
				owner: this.settings.owner,
				repo: this.settings.repo,
				ref: `heads/${this.settings.branch}`
			})
			const latestCommitSha = latestCommit.data.object.sha;
			const latestCommitData = await this.fit.octokit.rest.git.getCommit({
				owner: this.settings.owner,
				repo: this.settings.repo,
				commit_sha: latestCommitSha
			})
			const files = this.app.vault.getFiles()
			const content = await this.app.vault.adapter.read(files[0].path)
			const blob = await this.fit.octokit.rest.git.createBlob({
				owner: this.settings.owner,
				repo: this.settings.repo,
				content,
				encoding: 'utf-8',
			})
			const tree = [{
				path: files[0].path,
				mode: `100644`,
				type: `blob`,
				sha: blob.data.sha
			}]
			const newTree = await this.fit.octokit.rest.git.createTree({
				owner: this.settings.owner,
				repo: this.settings.repo,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				tree: tree as any,
				base_tree: latestCommitData.data.tree.sha
			})
			const message = `Commit from ${this.settings.deviceName} on ${new Date().toLocaleString()}`
			const newCommit = await this.fit.octokit.rest.git.createCommit({
				owner: this.settings.owner,
				repo: this.settings.repo,
				message,
				tree: newTree.data.sha,
				parents: [latestCommitSha]
			})
			const updatedRef = await this.fit.octokit.rest.git.updateRef({
				owner: this.settings.owner,
				repo: this.settings.repo,
				ref: `heads/${this.settings.branch}`,
				sha: newCommit.data.sha
			})
			console.log(updatedRef.data.url)
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

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

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
