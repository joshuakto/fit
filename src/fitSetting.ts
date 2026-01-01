import FitPlugin from "@main";
import { App, PluginSettingTab, Setting } from "obsidian";
import { setEqual } from "./utils";

type RefreshCheckPoint = "repo(0)" | "branch(1)" | "link(2)" | "initialize" | "withCache";

/**
 * Settings UI for Fit plugin.
 *
 * Key features:
 * - HTML5 datalist combo boxes for owner/repo/branch (supports both dropdown suggestions and freeform text entry)
 * - Automatic population of suggestions when authenticated via GitHubConnection
 * - Debounced branch fetching when owner or repo changes (500ms delay to reduce API calls)
 * - Supports contributor repos: type any owner/repo, not just repos you own
 * - No manual entry toggle needed - combo boxes unify both workflows
 *
 * Architecture:
 * - Uses GitHubConnection for PAT-based operations (auth, repo discovery, branch listing)
 * - Settings changes trigger debounced saves to avoid overwhelming storage on every keystroke
 * - Refresh operations update dropdown suggestions without clearing user input
 */
export default class FitSettingTab extends PluginSettingTab {
	plugin: FitPlugin;
	authenticating: boolean;
	authUserAvatar: HTMLDivElement;
	authUserHandle: HTMLSpanElement;
	patSetting: Setting;
	authUserSetting: Setting;
	ownerSetting: Setting;
	repoSetting: Setting;
	branchSetting: Setting;
	existingRepos: Array<string>;
	existingBranches: Array<string>;
	repoLink: string;
	private saveSettingsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private suggestedOwners: Array<string> = [];
	private suggestedRepos: Array<string> = [];
	private authenticateButtonComponent: { setDisabled: (disabled: boolean) => void } | null = null;
	private refreshButton: HTMLElement | null = null;
	private ownerInputComponent: { setPlaceholder: (placeholder: string) => void; setValue: (value: string) => void } | null = null;
	private repoInputComponent: { setPlaceholder: (placeholder: string) => void; setValue: (value: string) => void } | null = null;

	constructor(app: App, plugin: FitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.repoLink = this.getLatestLink();
		this.authenticating = false;
		this.existingRepos = [];
		this.existingBranches = [];
	}

	/**
	 * Update input placeholders to reflect current authentication state.
	 * Call after authentication succeeds or when GitHubConnection becomes available.
	 */
	private updatePlaceholders() {
		const isAuthenticated = !!this.plugin.githubConnection;

		if (this.ownerInputComponent) {
			this.ownerInputComponent.setPlaceholder(
				isAuthenticated ? 'owner-username' : 'Authenticate above to auto-fill'
			);
		}
		if (this.repoInputComponent) {
			this.repoInputComponent.setPlaceholder(
				isAuthenticated ? 'repo-name' : 'Authenticate above for suggestions'
			);
		}
	}

	/**
	 * Clear authentication UI state only (not persistent settings).
	 * Call this when authentication fails temporarily.
	 * For permanent PAT removal, caller should also clear settings separately.
	 */
	private clearAuthState = () => {
		// Clear only UI state, preserve settings so they work when auth is restored
		this.plugin.settings.avatarUrl = "";
		this.existingBranches = [];
		this.existingRepos = [];
		this.authUserAvatar.empty();
		this.authUserAvatar.removeClass('cat');
		this.authUserAvatar.removeClass('error');
		this.authUserAvatar.addClass('empty');
		this.authUserHandle.setText("Unauthenticated");

		// Don't clear input values - user's settings remain intact
		// They can still see what owner/repo/branch they had configured
	};

	/**
	 * Update button enabled/disabled states based on current authentication status.
	 * Call this whenever PAT or authentication state changes.
	 */
	private updateButtonStates = () => {
		const isAuthenticated = !!this.plugin.githubConnection;

		if (this.authenticateButtonComponent) {
			this.authenticateButtonComponent.setDisabled(this.authenticating || !this.plugin.githubConnection);
		}

		if (this.refreshButton) {
			this.refreshButton.toggleClass('is-disabled', !isAuthenticated);
			if (!isAuthenticated) {
				this.refreshButton.setAttribute('aria-disabled', 'true');
			} else {
				this.refreshButton.removeAttribute('aria-disabled');
			}
		}
	};

	/**
	 * Debounced save settings for manual entry fields.
	 * Waits 500ms after user stops typing before saving.
	 */
	private debouncedSaveSettings = () => {
		if (this.saveSettingsDebounceTimer) {
			clearTimeout(this.saveSettingsDebounceTimer);
		}
		this.saveSettingsDebounceTimer = setTimeout(async () => {
			this.saveSettingsDebounceTimer = null;
			await this.plugin.saveSettings();
		}, 500);
	};

	/**
	 * Debounced refresh for repo owner/name changes.
	 * Waits 500ms after user stops typing before fetching branches.
	 */
	private debouncedRefreshBranches = () => {
		if (this.refreshDebounceTimer) {
			clearTimeout(this.refreshDebounceTimer);
		}
		this.refreshDebounceTimer = setTimeout(async () => {
			this.refreshDebounceTimer = null;
			// Only refresh if both owner and repo are filled in
			if (this.plugin.settings.owner && this.plugin.settings.repo) {
				await this.refreshFields('branch(1)');
			}
		}, 500);
	};

	getLatestLink = (): string => {
		const {owner: owner, repo, branch} = this.plugin.settings;
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
			// Guard: githubConnection is null when no PAT configured
			if (!this.plugin.githubConnection) {
				this.plugin.logger.log('[FitSettings] Cannot authenticate without PAT token');
				this.authUserAvatar.removeClass('cat');
				this.authUserAvatar.addClass('error');
				this.authUserHandle.setText('Enter PAT token above');
				return;
			}
			const {owner: authUser, avatarUrl} = await this.plugin.githubConnection.getAuthenticatedUser();
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.createEl('img', { attr: { src: avatarUrl } });

			// Detect if authUser changed by checking the displayed handle
			const previousAuthUser = this.authUserHandle.textContent;
			const authUserChanged = previousAuthUser !== "Unauthenticated" && previousAuthUser !== authUser;
			this.authUserHandle.setText(authUser);

			const previousOwner = this.plugin.settings.owner;
			const ownerInputEmpty = !previousOwner || previousOwner.trim() === '';
			this.plugin.settings.avatarUrl = avatarUrl;

			// Pre-fill or update owner when:
			// 1. Owner input is empty (first time or user cleared it), OR
			// 2. AuthUser changed and owner was still empty
			if (ownerInputEmpty || (authUserChanged && ownerInputEmpty)) {
				this.plugin.settings.owner = authUser;
				// Update owner input value directly
				if (this.ownerInputComponent) {
					this.ownerInputComponent.setValue(authUser);
				}
			}

			await this.plugin.saveSettings();

			// Update placeholders to reflect authenticated state
			this.updatePlaceholders();

			// Refresh repos/branches if owner was just filled or changed
			if (ownerInputEmpty && this.plugin.settings.owner) {
				if (this.plugin.settings.repo) {
					await this.refreshFields('branch(1)');
				} else {
					await this.refreshFields('repo(0)');
				}
			}
		} catch (error) {
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.addClass('error');

			// Provide specific error message based on error type
			let errorMessage = "Authentication failed, make sure your token has not expired.";
			if (error instanceof Error) {
				if (error.message.includes("network") || error.message.includes("reach")) {
					errorMessage = "Network error. Check your connection and try again.";
				} else if (error.message.includes("Authentication") || error.message.includes("401") || error.message.includes("403")) {
					errorMessage = "Authentication failed. Check your PAT token.";
				}
			}

			this.authUserHandle.setText(errorMessage);
			// Clear remoteVault to allow re-creation on next auth attempt
			this.plugin.fit.clearRemoteVault();
			this.clearAuthState();
			await this.plugin.saveSettings();
			await this.refreshFields('initialize');

			// Update placeholders after clearing auth state
			this.updatePlaceholders();
		} finally {
			this.authenticating = false;
			this.updateButtonStates();
		}
	};

	githubUserInfoBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading()
			.setName("GitHub user info")
			.addButton(button => {
				this.authenticateButtonComponent = button;
				button
					.setCta()
					.setButtonText("Authenticate user")
					.setDisabled(this.authenticating || !this.plugin.githubConnection)
					.onClick(async ()=>{
						if (this.authenticating) return;
						await this.handleUserFetch();
					});
			});
		this.authUserSetting = new Setting(containerEl)
			.setDesc("Input your personal access token below to get authenticated. Create a GitHub account here if you don't have one yet.")
			.addExtraButton(button=>button
				.setIcon('github')
				.setTooltip("Sign up on github.com")
				.onClick(async ()=>{
					window.open("https://github.com/signup", "_blank");
				}));
		this.authUserSetting.nameEl.addClass('fit-avatar-container');
		this.authUserAvatar = this.authUserSetting.nameEl.createDiv({cls: 'fit-avatar-container empty'});
		this.authUserHandle = this.authUserSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
		this.authUserHandle.setText("Unauthenticated");

		// Try to get authenticated user info from GitHubConnection (cached)
		if (this.plugin.githubConnection) {
			this.plugin.githubConnection.getAuthenticatedUser().then(({owner, avatarUrl}) => {
				this.authUserAvatar.removeClass('empty');
				this.authUserAvatar.empty();
				this.authUserAvatar.createEl('img', { attr: { src: avatarUrl } });
				this.authUserHandle.setText(owner);
			}).catch(() => {
				// Authentication failed, keep "Unauthenticated" state
			});
		}
		// hide the control element to make space for authUser
		this.authUserSetting.controlEl.addClass('fit-avatar-display-text');

		this.patSetting = new Setting(containerEl)
			.setName('Github personal access token')
			.setDesc('Make sure Permissions has Contents: "Read and write". Recommended: Limit to selected repository, adjust expiration.')
			.addText(text => text
				.setPlaceholder('GitHub personal access token')
				.setValue(this.plugin.settings.pat)
				.onChange(async (value) => {
					const hadPat = !!this.plugin.settings.pat;
					this.plugin.settings.pat = value;

					// Clear authentication state when PAT is removed
					if (hadPat && !value) {
						this.clearAuthState();
						// When PAT is explicitly removed, also clear repo settings
						this.plugin.settings.owner = "";
						this.plugin.settings.repo = "";
						this.plugin.settings.branch = "";
						// Clear input values to reflect empty settings
						if (this.ownerInputComponent) {
							this.ownerInputComponent.setValue('');
						}
						if (this.repoInputComponent) {
							this.repoInputComponent.setValue('');
						}
					}

					await this.plugin.saveSettings();

					// Update button states after PAT change
					this.updateButtonStates();

					// Update placeholders to reflect new auth state
					this.updatePlaceholders();
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
		const isAuthenticated = !!this.plugin.githubConnection;
		new Setting(containerEl).setHeading().setName("Repository info")
			.setDesc(isAuthenticated
				? "Suggestions populate automatically when authenticated. Click refresh to update the lists."
				: "Authenticate above to populate owner/repo suggestions, or type custom values manually.")
			.addExtraButton(button => {
				this.refreshButton = button.extraSettingsEl;
				button
					.setTooltip("Refresh repos and branches list")
					.setDisabled(!isAuthenticated)
					.setIcon('refresh-cw')
					.onClick(async () => {
						await this.refreshFields('repo(0)');
					});
			});

		new Setting(containerEl)
			.setDesc("Make sure you are logged in to github on your browser.")
			.addExtraButton(button => button
				.setIcon('github')
				.setTooltip("Create a new repository")
				.onClick(() => {
					window.open(`https://github.com/new`, '_blank');
				}));

		// Repository owner combo box (supports both dropdown suggestions and freeform text)
		this.ownerSetting = new Setting(containerEl)
			.setName('Repository owner')
			.setDesc(isAuthenticated
				? 'The GitHub username or organization that owns the repository. Select from suggestions or type a custom value.'
				: 'Type a custom value, or authenticate above to see suggestions.');

		// Create datalist for owner suggestions
		const ownerDatalistId = 'fit-owner-datalist';
		containerEl.createEl('datalist', { attr: { id: ownerDatalistId } });

		this.ownerSetting.addText(text => {
			this.ownerInputComponent = text;  // Store reference for later updates
			text.inputEl.setAttribute('list', ownerDatalistId);
			text.setPlaceholder(isAuthenticated ? 'owner-username' : 'Authenticate above to auto-fill')
				.setValue(this.plugin.settings.owner)
				.onChange(async (value) => {
					const ownerChanged = value !== this.plugin.settings.owner;
					this.plugin.settings.owner = value;
					this.debouncedSaveSettings();

					if (ownerChanged && value) {
						// Refresh repo suggestions for new owner
						const repo_datalist = containerEl.querySelector('#fit-repo-datalist') as HTMLDataListElement;
						try {
							this.existingRepos = await this.plugin.githubConnection!.getReposForOwner(value);
							repo_datalist.empty();
							this.existingRepos.forEach(repo => {
								repo_datalist.createEl('option', { attr: { value: repo } });
							});
						} catch (error) {
							// Owner not found or inaccessible - clear repo suggestions
							repo_datalist.empty();
							this.existingRepos = [];
							const errorMsg = error instanceof Error ? error.message : String(error);
							this.plugin.logger.log(`[FitSettings] Could not fetch repos for owner '${value}': ${errorMsg}`, { error });
						}
					}

					this.debouncedRefreshBranches();
				});
		});

		// Repository name combo box (supports both dropdown suggestions and freeform text)
		this.repoSetting = new Setting(containerEl)
			.setName('Repository name')
			.setDesc(isAuthenticated
				? 'Select a repo to sync your vault or type a custom value. Refresh to see your latest repos.'
				: 'Authenticate above to see repo suggestions, or type a custom value.');

		// Create datalist for repo suggestions
		const repoDatalistId = 'fit-repo-datalist';
		containerEl.createEl('datalist', { attr: { id: repoDatalistId } });

		this.repoSetting.addText(text => {
			this.repoInputComponent = text;  // Store reference for later updates
			text.inputEl.setAttribute('list', repoDatalistId);
			text.setPlaceholder(isAuthenticated ? 'repo-name' : 'Authenticate above for suggestions')
				.setValue(this.plugin.settings.repo)
				.onChange((value) => {
					this.plugin.settings.repo = value;
					this.debouncedSaveSettings();
					this.debouncedRefreshBranches();
				});
		});

		this.branchSetting = new Setting(containerEl)
			.setName('Branch name')
			.setDesc('Enter repository details above, then refresh to view existing branches.')
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

	// TODO: This method does too much and has confusing checkpoint-based control flow.
	// Consider splitting into separate methods: refreshOwners(), refreshRepos(), refreshBranches(), updateLink()
	// Then callers can explicitly request what they need instead of using magic strings like "repo(0)"
	refreshFields = async (refreshFrom: RefreshCheckPoint) => {
		const {containerEl} = this;
		const owner_datalist = containerEl.querySelector('#fit-owner-datalist') as HTMLDataListElement;
		const repo_datalist = containerEl.querySelector('#fit-repo-datalist') as HTMLDataListElement;
		const branch_dropdown = containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		const link_el = containerEl.querySelector('.link-desc') as HTMLElement;

		// Update owner input field value (doesn't refresh automatically since it's not a dropdown/datalist)
		const ownerInput = containerEl.querySelector('input[list="fit-owner-datalist"]') as HTMLInputElement;
		if (ownerInput && (refreshFrom === "repo(0)" || refreshFrom === "initialize")) {
			ownerInput.value = this.plugin.settings.owner;
		}

		if (refreshFrom === "repo(0)") {
			// Guard: Cannot fetch from API without githubConnection
			if (!this.plugin.githubConnection) {
				this.plugin.logger.log('[FitSettings] Cannot refresh repos without PAT token');
				return;
			}

			// Fetch owners and populate owner datalist
			try {
				this.suggestedOwners = await this.plugin.githubConnection.getAccessibleOwners();
				owner_datalist.empty();
				this.suggestedOwners.forEach(owner => {
					owner_datalist.createEl('option', { attr: { value: owner } });
				});
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Could not fetch accessible owners: ${errorMsg}`, { error });
				this.suggestedOwners = [];
				owner_datalist.empty();
			}

			// Fetch repos for current owner and populate repo datalist
			if (this.plugin.settings.owner) {
				try {
					this.existingRepos = await this.plugin.githubConnection.getReposForOwner(this.plugin.settings.owner);
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.plugin.logger.log(`[FitSettings] Could not fetch repos for owner '${this.plugin.settings.owner}': ${errorMsg}`, { error });
					this.existingRepos = [];
				}
			} else {
				this.existingRepos = [];
			}
			repo_datalist.empty();
			this.existingRepos.forEach(repo => {
				repo_datalist.createEl('option', { attr: { value: repo } });
			});
		}

		if (refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			// Guard: Cannot fetch from API without githubConnection
			if (!this.plugin.githubConnection) {
				this.plugin.logger.log('[FitSettings] Cannot refresh branches without PAT token');
				branch_dropdown.empty();
				this.existingBranches = [];
			} else if (this.plugin.settings.repo === "" || this.plugin.settings.owner === "") {
				branch_dropdown.empty();
				this.existingBranches = [];
			} else {
				try {
					const latestBranches = await this.plugin.githubConnection.getBranches(this.plugin.settings.owner, this.plugin.settings.repo);
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
				} catch (error) {
					// Repository not found or inaccessible - clear branch dropdown
					branch_dropdown.empty();
					this.existingBranches = [];
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.plugin.logger.log(`[FitSettings] Could not fetch branches for ${this.plugin.settings.owner}/${this.plugin.settings.repo}: ${errorMsg}`, { error });
				}
			}
			branch_dropdown.disabled = false;
		}

		if (refreshFrom === "link(2)" || refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			this.repoLink = this.getLatestLink();
			link_el.innerText = this.repoLink;
		}

		if (refreshFrom === "initialize") {
			owner_datalist.empty();
			repo_datalist.empty();
			branch_dropdown.empty();
			if (this.plugin.settings.branch) {
				branch_dropdown.add(new Option(this.plugin.settings.branch, this.plugin.settings.branch));
			}
			link_el.innerText = this.getLatestLink();
		}

		if (refreshFrom === "withCache") {
			// Populate datalists with cached data
			owner_datalist.empty();
			this.suggestedOwners.forEach(owner => {
				owner_datalist.createEl('option', { attr: { value: owner } });
			});

			repo_datalist.empty();
			this.existingRepos.forEach(repo => {
				repo_datalist.createEl('option', { attr: { value: repo } });
			});

			branch_dropdown.empty();
			if (this.existingBranches.length > 0) {
				this.existingBranches.forEach(branch => {
					branch_dropdown.add(new Option(branch, branch));
				});
				if (this.plugin.settings.branch === "") {
					branch_dropdown.selectedIndex = -1;
				} else {
					branch_dropdown.selectedIndex = this.existingBranches.indexOf(this.plugin.settings.branch);
					if (branch_dropdown.selectedIndex === -1) {
						this.plugin.logger.log(`[FitSettings] Selected branch ${this.plugin.settings.branch} not found in existing branches`, { existingBranches: this.existingBranches });
					}
				}
			} else if (this.plugin.settings.branch !== "") {
				branch_dropdown.add(new Option(this.plugin.settings.branch, this.plugin.settings.branch));
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
