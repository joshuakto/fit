import FitPlugin from "main";
import { App, PluginSettingTab, Setting } from "obsidian";

export default class FitSettingTab extends PluginSettingTab {
	plugin: FitPlugin;

	constructor(app: App, plugin: FitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Github personal access token')
			.setDesc('Remember to give it the appropriate access for reading and writing to the storage repo.')
			.addText(text => text
				.setPlaceholder('Enter your token')
				.setValue(this.plugin.settings.pat)
				.onChange(async (value) => {
					this.plugin.settings.pat = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Github username')
			.setDesc('Your github handle.')
			.addText(text => text
				.setPlaceholder('Enter your username')
				.setValue(this.plugin.settings.owner)
				.onChange(async (value) => {
					this.plugin.settings.owner = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Github repository name')
			.setDesc('The repo you dedicate to tracking this vault.')
			.addText(text => text
				.setPlaceholder('Enter your repository name')
				.setValue(this.plugin.settings.repo)
				.onChange(async (value) => {
					this.plugin.settings.repo = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Branch name')
			.setDesc('The branch name you set to push to (default to main)')
			.addText(text => text
				.setPlaceholder('Enter the branch name')
				.setValue(this.plugin.settings.branch)
				.onChange(async (value) => {
					this.plugin.settings.branch = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Device name')
			.setDesc('The name of this device, used to decorate commit message')
			.addText(text => text
				.setPlaceholder('Enter device name')
				.setValue(this.plugin.settings.deviceName)
				.onChange(async (value) => {
					this.plugin.settings.deviceName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Single button mode')
			.setDesc('Single button mode is in early alpha, (recommended to turn off and push and pull separately).')
			.addToggle(selected=>selected
				.setValue(this.plugin.settings.singleButtonMode)
				.onChange(async (selected) => {
					this.plugin.settings.singleButtonMode = selected;
					await this.plugin.saveSettings();
				})
			)
	}
}