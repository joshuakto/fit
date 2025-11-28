import FitPlugin from "@main";
import { App, PluginSettingTab, Setting } from "obsidian";
import { setEqual } from "./utils";
import { warn } from "console";

type RefreshCheckPoint = "repo(0)" | "branch(1)" | "link(2)" | "initialize" | "withCache";

export default class FitSettingTab extends PluginSettingTab {
	plugin: FitPlugin;
	authenticating: boolean;
	authUserAvatar: HTMLDivElement;
	authUserHandle: HTMLSpanElement;
	patSetting: Setting;
	ownerSetting: Setting;
	repoSetting: Setting;
	branchSetting: Setting;
	existingRepos: Array<string>;
	existingBranches: Array<string>;
	repoLink: string;

	constructor(app: App, plugin: FitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.repoLink = this.getLatestLink();
		this.authenticating = false;
		this.existingRepos = [];
		this.existingBranches = [];
	}

	getLatestLink = (): string => {
		const {owner, repo, branch} = this.plugin.settings;
		if (owner.length > 0 && repo.length > 0 && branch.length > 0) {
			return `https://github.com/${owner}/${repo}/tree/${branch}`;
		}
		return "";
	};

	handleUserFetch = async () => {
		this.authenticating = true;
		this.authUserAvatar.removeClass('error');
		this.authUserAvatar.empty();
		this.authUserAvatar.removeClass('empty');
		this.authUserAvatar.addClass('cat');
		try {
			const {owner, avatarUrl} = await this.plugin.fit.getUser();
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.createEl('img', { attr: { src: avatarUrl } });
			this.authUserHandle.setText(owner);
			if (owner !== this.plugin.settings.owner) {
				this.plugin.settings.owner = owner;
				this.plugin.settings.avatarUrl = avatarUrl;
				this.plugin.settings.repo = "";
				this.plugin.settings.branch = "";
				this.existingBranches = [];
				this.existingRepos = [];
				await this.plugin.saveSettings();
				await this.refreshFields('repo(0)');
			}
			this.authenticating = false;
		} catch (_error) {
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.addClass('error');
			this.authUserHandle.setText("Authentication failed, make sure your token has not expired.");
			this.plugin.settings.owner = "";
			this.plugin.settings.avatarUrl = "";
			this.plugin.settings.repo = "";
			this.plugin.settings.branch = "";
			this.existingBranches = [];
			this.existingRepos = [];
			await this.plugin.saveSettings();
			this.refreshFields('initialize');
			this.authenticating = false;
		}
	};

	githubUserInfoBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading()
			.setName("GitHub user info")
			.addButton(button => button
				.setCta()
				.setButtonText("Authenticate user")
				.setDisabled(this.authenticating)
				.onClick(async ()=>{
					if (this.authenticating) return;
					await this.handleUserFetch();
				}));
		this.ownerSetting = new Setting(containerEl)
			.setDesc("Input your personal access token below to get authenticated. Create a GitHub account here if you don't have one yet.")
			.addExtraButton(button=>button
				.setIcon('github')
				.setTooltip("Sign up on github.com")
				.onClick(async ()=>{
					window.open("https://github.com/signup", "_blank");
				}));
		this.ownerSetting.nameEl.addClass('fit-avatar-container');
		if (this.plugin.settings.owner === "") {
			this.authUserAvatar = this.ownerSetting.nameEl.createDiv(
				{cls: 'fit-avatar-container empty'});
			this.authUserHandle = this.ownerSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
			this.authUserHandle.setText("Unauthenticated");
		} else {
			this.authUserAvatar = this.ownerSetting.nameEl.createDiv(
				{cls: 'fit-avatar-container'});
			this.authUserAvatar.createEl('img', { attr: { src: this.plugin.settings.avatarUrl } });
			this.authUserHandle = this.ownerSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
			this.authUserHandle.setText(this.plugin.settings.owner);
		}
		// hide the control element to make space for authUser
		this.ownerSetting.controlEl.addClass('fit-avatar-display-text');

		this.patSetting = new Setting(containerEl)
			.setName('Github personal access token')
			.setDesc('Make sure Permissions has Contents: "Read and write". Recommended: Limit to selected repository, adjust expiration.')
			.addText(text => text
				.setPlaceholder('GitHub personal access token')
				.setValue(this.plugin.settings.pat)
				.onChange(async (value) => {
					this.plugin.settings.pat = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button=>button
				.setIcon('external-link')
				.setTooltip("Create a token")
				.onClick(async ()=>{
					window.open(
						"https://github.com/settings/personal-access-tokens/new?name=Obsidian%20FIT&description=Obsidian%20FIT%20plugin&contents=write",
						'_blank');
				}));
	};

	repoInfoBlock = async () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading().setName("Repository info")
			.setDesc("Refresh to retrieve the latest list of repos and branches.")
			.addExtraButton(button => button
				.setTooltip("Refresh repos and branches list")
				.setDisabled(this.plugin.settings.owner === "")
				.setIcon('refresh-cw')
				.onClick(async () => {
					await this.refreshFields('repo(0)');
				}));

		new Setting(containerEl)
			.setDesc("Make sure you are logged in to github on your browser.")
			.addExtraButton(button => button
				.setIcon('github')
				.setTooltip("Create a new repository")
				.onClick(() => {
					window.open(`https://github.com/new`, '_blank');
				}));

		this.repoSetting = new Setting(containerEl)
			.setName('Github repository name')
			.setDesc("Select a repo to sync your vault, refresh to see your latest repos. If some repos are missing, make sure your token are granted access to them.")
			.addDropdown(dropdown => {
				dropdown.selectEl.addClass('repo-dropdown');
				this.existingRepos.map(repo=>dropdown.addOption(repo, repo));
				dropdown.setDisabled(this.existingRepos.length === 0);
				dropdown.setValue(this.plugin.settings.repo);
				dropdown.onChange(async (value) => {
					const repoChanged = value !== this.plugin.settings.repo;
					if (repoChanged) {
						this.plugin.settings.repo = value;
						await this.plugin.saveSettings();
						await this.refreshFields('branch(1)');
					}
				});
			});

		this.branchSetting = new Setting(containerEl)
			.setName('Branch name')
			.setDesc('Select a repo above to view existing branches.')
			.addDropdown(dropdown => {
				dropdown.selectEl.addClass('branch-dropdown');
				dropdown.setDisabled(this.existingBranches.length === 0);
				this.existingBranches.map(repo=>dropdown.addOption(repo, repo));
				dropdown.setValue(this.plugin.settings.branch);
				dropdown.onChange(async (value) => {
					const branchChanged = value !== this.plugin.settings.branch;
					if (branchChanged) {
						this.plugin.settings.branch = value;
						await this.plugin.saveSettings();
						await this.refreshFields('link(2)');
					}
				});
			});

		this.repoLink = this.getLatestLink();
		const linkDisplay = new Setting(containerEl)
			.setName("View your vault on GitHub")
			.setDesc(this.repoLink)
			.addExtraButton(button => button
				.setDisabled(this.repoLink.length === 0)
				.setTooltip("Open on GitHub")
				.setIcon('external-link')
				.onClick(() => {
					console.log(`opening ${this.repoLink}`);
					window.open(this.repoLink, '_blank');
				})
			);
		linkDisplay.descEl.addClass("link-desc");
	};

	localConfigBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading().setName("Local configurations");
		new Setting(containerEl)
			.setName('Device name')
			.setDesc('Sign commit message with this device name.')
			.addText(text => text
				.setPlaceholder('Device name')
				.setValue(this.plugin.settings.deviceName)
				.onChange(async (value) => {
					this.plugin.settings.deviceName = value;
					await this.plugin.saveSettings();
				}));


		new Setting(containerEl)
			.setName("Auto sync")
			.setDesc(`Automatically sync your vault when remote has updates. (Muted: sync in the background without displaying notices, except for file changes and conflicts notice)`)
			.addDropdown(dropdown => {
				dropdown
					.addOption('off', 'Off')
					.addOption('muted', 'Muted')
					.addOption('remind', 'Remind only')
					.addOption('on', 'On')
					.setValue(this.plugin.settings.autoSync ? this.plugin.settings.autoSync : 'off')
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value as "off" | "muted" | "remind" | "on";
						checkIntervalSlider.settingEl.addClass(value === "off" ? "clear" : "restore");
						checkIntervalSlider.settingEl.removeClass(value === "off" ? "restore" : "clear");
						await this.plugin.saveSettings();
					});
			});

		const checkIntervalSlider = new Setting(containerEl)
			.setName('Auto check interval')
			.setDesc(`Automatically check for remote changes in the background every ${this.plugin.settings.checkEveryXMinutes} minutes.`)
			.addSlider(slider => slider
				.setLimits(1, 60, 1)
				.setValue(this.plugin.settings.checkEveryXMinutes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.checkEveryXMinutes = value;
					await this.plugin.saveSettings();
					checkIntervalSlider.setDesc(`Automatically check for remote changes in the background every ${value} minutes.`);
				})
			);

		if (this.plugin.settings.autoSync === "off") {
			checkIntervalSlider.settingEl.addClass("clear");
		}
	};

	noticeConfigBlock = () => {
		const {containerEl} = this;
		const selectedCol = "var(--interactive-accent)";
		const selectedTxtCol = "var(--text-on-accent)";
		const unselectedColor = "var(--interactive-normal)";
		const unselectedTxtCol = "var(--text-normal)";
		const stateTextMap = (notifyConflicts: boolean, notifyChanges: boolean) => {
			if (notifyConflicts && notifyChanges) {
				return "Displaying file changes and conflicts ";
			} else if (!notifyConflicts && notifyChanges) {
				return "Displaying file changes ";
			} else if (notifyConflicts && !notifyChanges) {
				return "Displaying change conflicts ";
			} else {
				return "No notice displayed ";
			}
		};
		const noticeDisplay = new Setting(containerEl)
			.setName("Notice display")
			.setDesc(`${stateTextMap(this.plugin.settings.notifyConflicts, this.plugin.settings.notifyChanges)} after sync.`);

		noticeDisplay.addButton(button => {
			button.setButtonText("Change conflicts");
			button.onClick(async () => {
				const notifyConflicts = !this.plugin.settings.notifyConflicts;
				this.plugin.settings.notifyConflicts = notifyConflicts;
				await this.plugin.saveSettings();
				button.buttonEl.setCssStyles({
					"background": notifyConflicts ? selectedCol : unselectedColor,
					"color": notifyConflicts ? selectedTxtCol : unselectedTxtCol,
				});
				noticeDisplay.setDesc(`${stateTextMap(notifyConflicts, this.plugin.settings.notifyChanges)} after sync.`);
			});
			button.buttonEl.setCssStyles({
				"background": this.plugin.settings.notifyConflicts ? selectedCol : unselectedColor,
				"color": this.plugin.settings.notifyConflicts ? selectedTxtCol : unselectedTxtCol,
			});
		});
		noticeDisplay.addButton(button => {
			button.setButtonText("File changes");
			button.onClick(async () => {
				const notifyChanges = !this.plugin.settings.notifyChanges;
				this.plugin.settings.notifyChanges = notifyChanges;
				await this.plugin.saveSettings();
				button.buttonEl.setCssStyles({
					"background": notifyChanges ? selectedCol : unselectedColor,
					"color": notifyChanges ? selectedTxtCol : unselectedTxtCol,
				});
				noticeDisplay.setDesc(`${stateTextMap(this.plugin.settings.notifyConflicts, notifyChanges)} after sync.`);
			});
			button.buttonEl.setCssStyles({
				"background": this.plugin.settings.notifyChanges ? selectedCol : unselectedColor,
				"color": this.plugin.settings.notifyChanges ? selectedTxtCol : unselectedTxtCol,
			});
		});

		// Debug logging setting
		new Setting(containerEl)
			.setName("Enable debug logging")
			.setDesc(`Write detailed sync logs to ${this.plugin.manifest.dir}/debug.log. Useful for troubleshooting and bug reports.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
					// Update logger immediately
					const { fitLogger } = await import('./logger');
					fitLogger.setEnabled(value);
					if (value) {
						fitLogger.log('[Settings] Debug logging enabled');
					}
				}));
	};

	refreshFields = async (refreshFrom: RefreshCheckPoint) => {
		const {containerEl} = this;
		const repo_dropdown = containerEl.querySelector('.repo-dropdown') as HTMLSelectElement;
		const branch_dropdown = containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		const link_el = containerEl.querySelector('.link-desc') as HTMLElement;
		if (refreshFrom === "repo(0)") {
			repo_dropdown.disabled = true;
			branch_dropdown.disabled = true;
			this.existingRepos = await this.plugin.fit.getRepos();
			const repoOptions = Array.from(repo_dropdown.options).map(option => option.value);
			if (!setEqual<string>(this.existingRepos, repoOptions)) {
				repo_dropdown.empty();
				this.existingRepos.map(repo => {
					repo_dropdown.add(new Option(repo, repo));
				});
				// if original repo not in the updated existing repo, -1 will be returned
				const selectedRepoIndex = this.existingRepos.indexOf(this.plugin.settings.repo);
				// setting selectedIndex to -1 to indicate no options selected
				repo_dropdown.selectedIndex = selectedRepoIndex;
				if (selectedRepoIndex===-1){
					this.plugin.settings.repo = "";
				}
			}
			repo_dropdown.disabled = false;
		}
		if (refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			if (this.plugin.settings.repo === "") {
				branch_dropdown.empty();
			} else {
				const latestBranches = await this.plugin.fit.getBranches();
				if (!setEqual<string>(this.existingBranches, latestBranches)) {
					branch_dropdown.empty();
					this.existingBranches = latestBranches;
					this.existingBranches.map(branch => {
						branch_dropdown.add(new Option(branch, branch));
					});
					// if original branch not in the updated existing branch, -1 will be returned
					const selectedBranchIndex = this.existingBranches.indexOf(this.plugin.settings.branch);
					// setting selectedIndex to -1 to indicate no options selected
					branch_dropdown.selectedIndex = selectedBranchIndex;
					if (selectedBranchIndex===-1){
						this.plugin.settings.branch = "";
					}
				}
			}
			branch_dropdown.disabled = false;
		}
		if (refreshFrom === "link(2)" || refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			this.repoLink = this.getLatestLink();
			link_el.innerText = this.repoLink;
		}
		if (refreshFrom === "initialize") {
			const {repo, branch} = this.plugin.settings;
			repo_dropdown.empty();
			branch_dropdown.empty();
			repo_dropdown.add(new Option(repo, repo));
			branch_dropdown.add(new Option(branch, branch));
			link_el.innerText = this.getLatestLink();
		}
		if (refreshFrom === "withCache") {
			repo_dropdown.empty();
			branch_dropdown.empty();
			if (this.existingRepos.length > 0) {
				this.existingRepos.map(repo => {
					repo_dropdown.add(new Option(repo, repo));
				});
				repo_dropdown.selectedIndex = this.existingRepos.indexOf(this.plugin.settings.repo);
			}
			if (this.existingBranches.length > 0) {
				this.existingBranches.map(branch => {
					branch_dropdown.add(new Option(branch, branch));
				});
				if (this.plugin.settings.branch === "") {
					branch_dropdown.selectedIndex = -1;
				}
				branch_dropdown.selectedIndex = this.existingBranches.indexOf(this.plugin.settings.branch);
			}
			if (this.plugin.settings.repo !== "") {
				if (this.existingRepos.length === 0) {
					repo_dropdown.add(new Option(this.plugin.settings.repo, this.plugin.settings.repo));
				} else {
					repo_dropdown.selectedIndex = this.existingRepos.indexOf(this.plugin.settings.repo);
					if (branch_dropdown.selectedIndex === -1) {
						warn(`warning: selected branch ${this.plugin.settings.branch} not found, existing branches: ${this.existingBranches}`);
					}
				}
			}
			if (this.plugin.settings.branch !== "") {
				if (this.existingBranches.length === 0) {
					branch_dropdown.add(new Option(this.plugin.settings.branch, this.plugin.settings.branch));
				} else {
					branch_dropdown.selectedIndex = this.existingBranches.indexOf(this.plugin.settings.branch);
					if (branch_dropdown.selectedIndex === -1) {
						warn(`warning: selected branch ${this.plugin.settings.branch} not found, existing branches: ${this.existingBranches}`);
					}
				}
			}
		}
	};


	async display(): Promise<void> {
		const {containerEl} = this;

		containerEl.empty();

		this.githubUserInfoBlock();
		this.repoInfoBlock();
		this.localConfigBlock();
		this.noticeConfigBlock();
		this.refreshFields("withCache");
	}
}
