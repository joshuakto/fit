import FitPlugin from "@/fitPlugin";
import { findNewFields, isUiManaged } from "@/fitSettings";
import { OBSIDIAN_ALWAYS_EXCLUDED, OBSIDIAN_NEEDS_MERGE } from "@/fit";
import { App, PluginSettingTab, Setting, TextComponent } from "obsidian";
import { setEqual } from "./utils";
import { GitHubOwnerSuggest, GitHubRepoSuggest, ObsidianPathSuggest } from "./util/obsidianHelpers";
import { VaultError } from "./vault";
import { fitLogger } from "./logger";
import FitNotice from "./fitNotice";
import * as Encryption from "./encryption";

type RefreshCheckPoint = "repo(0)" | "branch(1)" | "link(2)" | "initialize" | "withCache";

// Known .obsidian/ files with friendly display names.
// Must use "replace" strategy (v1 only). Paths in OBSIDIAN_ALWAYS_EXCLUDED are not listed.
const KNOWN_OBSIDIAN_FILES: { label: string; path: string }[] = [
	{ label: "Appearance (theme, fonts, CSS snippets)", path: ".obsidian/appearance.json" },
	{ label: "Core app settings",                       path: ".obsidian/app.json" },
	{ label: "Hotkeys",                                 path: ".obsidian/hotkeys.json" },
	{ label: "Daily notes settings",                    path: ".obsidian/daily-notes.json" },
	{ label: "Templates settings",                      path: ".obsidian/templates.json" },
	{ label: "Graph view settings",                     path: ".obsidian/graph.json" },
	{ label: "Canvas settings",                         path: ".obsidian/canvas.json" },
];

/**
 * Settings UI for Fit plugin.
 *
 * Sections:
 * - GitHub authentication (PAT token)
 * - Repository configuration (owner/repo/branch)
 * - Local settings (file exclusions, ignored files)
 * - Debug logging toggle
 *
 * Implementation notes:
 * - Owner/repo inputs use AbstractInputSuggest (mobile-friendly autocomplete)
 * - GitHubConnection provides repo discovery and branch listing
 * - Settings saves and branch fetching are debounced (500ms) to reduce API calls
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
	existingRepos: Array<string>;
	existingBranches: Array<string>;
	repoLink: string;
	private saveSettingsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private repoFetchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private suggestedOwners: Array<string> = [];
	private suggestedRepos: Array<string> = [];
	private authenticateButtonComponent: { setDisabled: (disabled: boolean) => void } | null = null;
	private refreshButton: HTMLElement | null = null;
	private ownerInputComponent: { setPlaceholder: (placeholder: string) => void; setValue: (value: string) => void } | null = null;
	private repoInputComponent: { setPlaceholder: (placeholder: string) => void; setValue: (value: string) => void } | null = null;
	private ownerSuggest: GitHubOwnerSuggest | null = null;
	private repoSuggest: GitHubRepoSuggest | null = null;

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
	 * Debounced fetch repos for owner changes.
	 * Waits 500ms after user stops typing before fetching repos to avoid performance issues.
	 */
	private debouncedFetchReposForOwner = (owner: string) => {
		if (this.repoFetchDebounceTimer) {
			clearTimeout(this.repoFetchDebounceTimer);
		}
		this.repoFetchDebounceTimer = setTimeout(async () => {
			this.repoFetchDebounceTimer = null;
			if (owner && this.plugin.githubConnection) {
				try {
					this.existingRepos = await this.plugin.githubConnection.getReposForOwner(owner);
					if (this.repoSuggest) {
						this.repoSuggest.updateSuggestions(this.existingRepos);
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.plugin.logger.log(`[FitSettings] Could not fetch repos for owner '${owner}': ${errorMsg}`, { error });
					this.existingRepos = [];
					if (this.repoSuggest) {
						this.repoSuggest.updateSuggestions([]);
					}
				}
			}
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

		// Create AbstractInputSuggest for owner suggestions (better mobile UX than datalist)
		this.ownerSetting.addText(text => {
			this.ownerInputComponent = text;
			text.setPlaceholder(isAuthenticated ? 'owner-username' : 'Authenticate above to auto-fill')
				.setValue(this.plugin.settings.owner)
				.onChange(async (value) => {
					const ownerChanged = value !== this.plugin.settings.owner;
					this.plugin.settings.owner = value;

					if (ownerChanged) {
						// Clear dependent fields whenever the owner changes
						this.plugin.settings.repo = '';
						this.plugin.settings.branch = '';
						this.repoInputComponent?.setValue('');
						this.existingRepos = [];

						// Update repo suggestions when owner changes
						if (this.repoSuggest) {
							this.repoSuggest.updateSuggestions([]);
						}

						// If authenticated, debounced fetch repos for the new owner
						if (value && this.plugin.githubConnection) {
							this.debouncedFetchReposForOwner(value);
						}
					}

					this.debouncedSaveSettings();
				});

			// Initialize AbstractInputSuggest for owner input
			try {
				this.ownerSuggest = new GitHubOwnerSuggest(
					this.app,
					text.inputEl
				);
				// Populate with current suggestions if available
				if (this.suggestedOwners.length > 0) {
					this.ownerSuggest.updateSuggestions(this.suggestedOwners);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Failed to initialize owner suggestions: ${errorMsg}`, { error });
				console.error('[FitSettings] Failed to initialize GitHubOwnerSuggest:', error);
			}
		});

		// Repository name combo box (supports both dropdown suggestions and freeform text)
		this.repoSetting = new Setting(containerEl)
			.setName('Repository name')
			.setDesc(isAuthenticated
				? 'Select a repo to sync your vault or type a custom value. Refresh to see your latest repos.'
				: 'Authenticate above to see repo suggestions, or type a custom value.');

		// Create AbstractInputSuggest for repo suggestions (better mobile UX than datalist)
		this.repoSetting.addText(text => {
			this.repoInputComponent = text;
			text.setPlaceholder(isAuthenticated ? 'repo-name' : 'Authenticate above for suggestions')
				.setValue(this.plugin.settings.repo)
				.onChange((value) => {
					this.plugin.settings.repo = value;
					this.debouncedSaveSettings();
					this.debouncedRefreshBranches();
				});

			// Initialize AbstractInputSuggest for repo input
			try {
				this.repoSuggest = new GitHubRepoSuggest(
					this.app,
					text.inputEl
				);
				// Populate with current suggestions if available
				if (this.existingRepos.length > 0) {
					this.repoSuggest.updateSuggestions(this.existingRepos);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Failed to initialize repo suggestions: ${errorMsg}`, { error });
				console.error('[FitSettings] Failed to initialize GitHubRepoSuggest:', error);
			}
		});

		new Setting(containerEl)
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

		let textComponent: TextComponent;
		let visible = false;
		const defaultType = "password";

		function message(notice: FitNotice, string: string, error: unknown = null) {
			const loggerPrefix = "[FitSettings] ";
			if (error) {
				const msg = error instanceof Error ? error.message : String(error);
				fitLogger.log(loggerPrefix + string, error);
				notice.setMessage(`${string}: ${msg}`, true);
			} else {
				fitLogger.log(loggerPrefix + string);
				notice.setMessage(string);
			}
		}

		const setting = new Setting(containerEl)
			.setName("Encryption password (Advanced only)")
			.setDesc(
				"⚠️ A password for encrypting your remote data. Leave empty to disable encryption.\n\n" +
				"Safe migration guide (read before changing):\n" +
				"1. Ensure all your devices have the same files in their vaults;\n" +
				"2. Configure and apply this setting the same way on all devices;\n" +
				"3. On one device, delete all remote files by clicking 'Clear repository' button and sync your vault with the repository;\n" +
				"4. On every other device, update the cache by clicking 'Sync local cache' button;\n" +
				"5. Done. Only after this can you modify the files in your vaults and sync normally."
			)
			.addText(text => {
				text.setPlaceholder("Password");
				text.setValue(this.plugin.settings.encryptionPassword);
				text.inputEl.type = defaultType;
				textComponent = text;
			});

		setting.descEl.style.whiteSpace = "pre-wrap";

		setting.addExtraButton(button => button
			.setIcon("eye")
			.setTooltip("Switch visibility")
			.onClick(() => {
				visible = !visible;
				textComponent.inputEl.type = visible ? "text" : "password";
				button.setIcon(visible ? "eye-off" : "eye");
			}));

		setting.addExtraButton(button => button
			.setIcon("arrow-right")
			.setTooltip("Apply password")
			.onClick(async () => {
				const value = textComponent.getValue();
				this.plugin.settings.encryptionPassword = value;
				await this.plugin.saveSettings();
				Encryption.clearCache();
				fitLogger.log("[FitSettings] Password has been applied");
				new FitNotice(
					this.plugin.fit,
					["done"],
					"Password has been applied",
					5000,
					false
				);
			}));

		new Setting(containerEl)
			.setName('Sync local cache')
			.setDesc('Re-read remote state into local cache. (Advanced use only — encryption migration or cache recovery)')
			.addExtraButton(button => button
				.setIcon('refresh-cw')
				.setTooltip("Sync local cache")
				.onClick(async () => {
					button.setDisabled(true);

					const notice = new FitNotice(
						this.plugin.fit,
						["done"],
						"Updating cache...",
						5000,
						false
					);

					try {
						const { state } = await this.plugin.fit.remoteVault.readFromSource(true);

						await this.plugin.saveLocalStoreCallback({
							lastFetchedRemoteShas: state,
						});

						message(notice, "Cache has been updated");
						notice.remove("done", 5000);
					} catch (e) {
						message(notice, "Failed to update cache", e);
						notice.remove("error", 5000);
					} finally {
						button.setDisabled(false);
					}
				}));

		new Setting(containerEl)
			.setName('Clear repository')
			.setDesc('Delete all files from the repository. Previous commits unaffected. (Advanced use only — encryption migration)')
			.addExtraButton(button => button
				.setIcon('trash-2')
				.setTooltip("Clear repository")
				.onClick(async () => {
					button.setDisabled(true);

					const notice = new FitNotice(
						this.plugin.fit,
						["loading"],
						"Clearing repository...",
						undefined,
						false
					);

					try {
						const applied = await this.plugin.fitSync.clear();
						message(notice, applied ? "Repository has been cleared" : "Nothing to clear");
						notice.remove("done", 5000);
					} catch (e) {
						message(notice, "Failed to clear repository", e);
						notice.remove("error", 5000);
					} finally {
						button.setDisabled(false);
					}
				}));
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

		// Hidden files setting
		new Setting(containerEl)
			.setName("Sync hidden files")
			.setDesc("Include files and folders whose names start with '.' (e.g. .gitignore, .env). " +
				"Disable if you notice slower syncs on a very large vault — " +
				"it adds a recursive directory scan on each sync. " +
				"Add a .gitignore to exclude specific hidden paths (e.g. .env, .DS_Store).")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncHiddenFiles)
				.onChange(async (value) => {
					this.plugin.settings.syncHiddenFiles = value;
					await this.plugin.saveSettings();
				}));
	};

	obsidianSyncBlock = () => {
		const {containerEl} = this;

		new Setting(containerEl)
			.setHeading()
			.setName("Obsidian config sync")
			.setDesc("Sync selected Obsidian config files across devices. " +
				"Workspace layout and FIT's own data are always excluded.");

		const rules = this.plugin.settings.obsidianSyncRules;

		const saveRules = async () => {
			await this.plugin.saveSettings();
			this.plugin.fit.loadSettings(this.plugin.settings);
		};

		// === Compact known-file list ===
		const knownGroup = containerEl.createDiv({ cls: 'fit-obsidian-sync-group' });
		for (const { label, path } of KNOWN_OBSIDIAN_FILES) {
			const shortPath = path.replace('.obsidian/', '');
			const row = knownGroup.createDiv({ cls: 'fit-obsidian-sync-row' });

			const labelEl = row.createDiv({ cls: 'fit-obsidian-sync-label' });
			const nameRow = labelEl.createDiv({ cls: 'fit-obsidian-sync-name' });
			nameRow.createSpan({ text: label });
			if (path in rules && !isUiManaged(rules[path])) {
				nameRow.createSpan({ text: ' — unknown rule', cls: 'fit-obsidian-unknown-rule' });
			}
			labelEl.createDiv({ text: shortPath, cls: 'fit-obsidian-sync-path' });

			const checked = path in rules && isUiManaged(rules[path]);
			const toggleEl = row.createDiv({ cls: `checkbox-container${checked ? ' is-enabled' : ''}` });
			toggleEl.createEl('input', { type: 'checkbox' });

			row.addEventListener('click', async () => {
				const nowEnabled = !toggleEl.hasClass('is-enabled');
				toggleEl.toggleClass('is-enabled', nowEnabled);
				if (nowEnabled) {
					rules[path] = {};
				} else if (!rules[path] || isUiManaged(rules[path])) {
					delete rules[path];
				}
				await saveRules();
			});
		}

		// === Custom paths ===

		// Build suggestion list from installed plugins (without .obsidian/ prefix — input shows that as a label)
		const pluginManifests: Record<string, unknown> =
			(this.plugin.app as unknown as { plugins?: { manifests?: Record<string, unknown> } })
				.plugins?.manifests ?? {};
		const pathSuggestions = Object.keys(pluginManifests)
			.filter(id => id !== this.plugin.manifest.id)
			.map(id => `plugins/${id}/data.json`);

		const denylistReason = (p: string): string | null => {
			if (OBSIDIAN_ALWAYS_EXCLUDED.has(p)) return 'Workspace layout is device-specific — always excluded';
			return null;
		};
		const isKnownTogglePath = (p: string) => KNOWN_OBSIDIAN_FILES.some(f => f.path === p);
		const needsMerge = (p: string) => OBSIDIAN_NEEDS_MERGE.has(p);

		// Plugin installer files — hard block (code, manifest, styles) or soft warn (docs)
		const isInstallerManagedFile = (rel: string): boolean => {
			if (!/^plugins\/[^/]+\//.test(rel)) return false;
			const filename = rel.split('/').pop() ?? '';
			return filename === 'manifest.json' || /\.(js|mjs|ts|css)$/.test(filename);
		};
		const isPluginDocFile = (rel: string): boolean => {
			if (!/^plugins\/[^/]+\//.test(rel)) return false;
			const filename = rel.split('/').pop() ?? '';
			return /\.md$/.test(filename);
		};

		const readJsonFields = async (vaultPath: string): Promise<string[] | null> => {
			try {
				const text = await this.plugin.app.vault.adapter.read(vaultPath);
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return Object.keys(parsed);
				}
			} catch {
				// file missing, unreadable, or not a JSON object
			}
			return null;
		};

		const customSection = containerEl.createDiv({ cls: 'fit-obsidian-custom-paths' });
		customSection.createDiv({ text: 'Additional paths', cls: 'fit-obsidian-custom-heading' });
		const pathsList = customSection.createDiv({ cls: 'fit-obsidian-paths-list' });

		const ownDataPath = this.plugin.manifest.dir
			? `${this.plugin.manifest.dir}/data.json`
			: '.obsidian/plugins/fit/data.json';

		const addPathRow = (initialRelative: string) => {
			let currentRelative = initialRelative;
			const row = pathsList.createDiv({ cls: 'fit-obsidian-custom-path-row' });
			const controls = row.createDiv({ cls: 'fit-obsidian-custom-path-controls' });

			const inputWrap = controls.createDiv({ cls: 'fit-obsidian-input-wrap' });
			inputWrap.createSpan({ text: '.obsidian/', cls: 'fit-obsidian-path-prefix' });
			const input = inputWrap.createEl('input', { cls: 'fit-obsidian-path-input' });
			input.placeholder = 'plugins/my-plugin/data.json';
			input.value = initialRelative;
			new ObsidianPathSuggest(this.app, input, pathSuggestions);

			const removeBtn = controls.createEl('button', { cls: 'fit-obsidian-remove-btn', text: '×' });
			const statusEl = row.createDiv({ cls: 'fit-obsidian-path-status' });

			const validate = (rel: string): boolean => {
				const full = `.obsidian/${rel}`;
				if (!rel) {
					statusEl.empty(); statusEl.className = 'fit-obsidian-path-status';
					return false;
				}
				const denyReason = denylistReason(full);
				if (denyReason) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status error';
					statusEl.setText(denyReason);
					return false;
				}
				if (full === ownDataPath) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status error';
					statusEl.createSpan({ text: 'Contains your GitHub token — syncing requires field-level exclusion not yet available (' });
					statusEl.createEl('a', { text: 'issue #67', href: 'https://github.com/joshuakto/fit/issues/67' });
					statusEl.createSpan({ text: ')' });
					return false;
				}
				if (needsMerge(full)) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status error';
					statusEl.createSpan({ text: 'Not yet supported — needs merge logic to avoid install conflicts (' });
					statusEl.createEl('a', { text: 'issue #67', href: 'https://github.com/joshuakto/fit/issues/67' });
					statusEl.createSpan({ text: ')' });
					return false;
				}
				if (isKnownTogglePath(full)) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status warning';
					statusEl.setText('Use the toggle above');
					return false;
				}
				if (/^plugins\/[^/]+\/data\.json$/.test(rel)) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status warning';
					statusEl.setText('Plugin data files often contain API tokens or credentials. Inspect this file before enabling sync — credential exposure via git history is hard to reverse.');
					return true;
				}
				if (isInstallerManagedFile(rel)) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status error';
					statusEl.setText('Plugin code and manifest files are managed by Obsidian\'s installer — syncing these will cause conflicts and is not supported');
					return false;
				}
				if (isPluginDocFile(rel)) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status warning';
					statusEl.setText('This file is part of the plugin installation — syncing it is unlikely to be useful');
					return true;
				}
				if (!rel.endsWith('.json')) {
					statusEl.empty();
					statusEl.className = 'fit-obsidian-path-status warning';
					statusEl.setText('Non-JSON file — make sure this isn\'t a secret or credential before syncing');
					return true;
				}
				statusEl.empty(); statusEl.className = 'fit-obsidian-path-status';
				return true;
			};

			// Async: check if file has gained top-level JSON fields not in rule.fields.
			// Only shows if statusEl is currently empty (doesn't override validation messages).
			const checkNewFieldsWarning = async (rel: string) => {
				if (!rel || statusEl.textContent) return;
				const full = `.obsidian/${rel}`;
				const rule = rules[full];
				if (!rule?.fields) return;
				const currentFields = await readJsonFields(full);
				// Guard: input may have changed while awaiting
				if (input.value.trim().replace(/^\.?obsidian\//, '') !== rel) return;
				if (!currentFields) return;
				const newFields = findNewFields(rule.fields, currentFields);
				if (newFields.length === 0) return;
				if (statusEl.textContent) return; // re-check after await
				statusEl.empty();
				statusEl.className = 'fit-obsidian-path-status warning';
				statusEl.setText(`New fields since last review: ${newFields.join(', ')} — focus input to acknowledge`);
			};

			if (validate(initialRelative)) {
				checkNewFieldsWarning(initialRelative);
			}

			// Merge current file's top-level fields into stored list on focus (additive, clears warning).
			input.addEventListener('focus', async () => {
				const rel = input.value.trim().replace(/^\.?obsidian\//, '');
				const full = `.obsidian/${rel}`;
				const rule = rules[full];
				if (!rel || !rule || rule.fields === undefined) return;
				const currentFields = await readJsonFields(full);
				if (currentFields) {
					rule.fields = Array.from(new Set([...rule.fields, ...currentFields]));
					await saveRules();
				}
				// Revalidate to restore clean statusEl (field warning now cleared)
				validate(rel);
			});

			// Validate on blur only — avoids suggestion-popover flicker from live DOM updates during input
			input.addEventListener('blur', () => {
				const rel = input.value.trim().replace(/^\.?obsidian\//, '');
				if (validate(rel)) {
					checkNewFieldsWarning(rel);
				}
			});

			input.addEventListener('change', async () => {
				const newRel = input.value.trim().replace(/^\.?obsidian\//, '');
				const oldFull = `.obsidian/${currentRelative}`;
				const newFull = `.obsidian/${newRel}`;

				if (currentRelative && oldFull !== newFull && rules[oldFull] && isUiManaged(rules[oldFull])) {
					delete rules[oldFull];
				}
				if (validate(newRel)) {
					if (!rules[newFull]) rules[newFull] = {};
					// Capture top-level fields on first enable (additive — preserves any existing list)
					if (newRel.endsWith('.json')) {
						const capturedFields = await readJsonFields(newFull);
						if (capturedFields) {
							const existing = rules[newFull].fields ?? [];
							rules[newFull].fields = Array.from(new Set([...existing, ...capturedFields]));
						}
					}
					currentRelative = newRel;
				}
				await saveRules();
			});

			removeBtn.addEventListener('click', async () => {
				const full = `.obsidian/${currentRelative}`;
				if (currentRelative && rules[full] && isUiManaged(rules[full])) {
					delete rules[full];
					await saveRules();
				}
				row.remove();
			});
		};

		// Render existing custom paths
		for (const fullPath of Object.keys(rules)) {
			if (!KNOWN_OBSIDIAN_FILES.some(f => f.path === fullPath) && isUiManaged(rules[fullPath])) {
				addPathRow(fullPath.replace('.obsidian/', ''));
			}
		}

		customSection.createEl('button', { cls: 'fit-obsidian-add-btn', text: '+ Add path' })
			.addEventListener('click', () => addPathRow(''));

		// Unrecognized-rule entries: read-only, so users know they exist and won't accidentally delete them
		const futureEntries = Object.entries(rules).filter(([, rule]) => !isUiManaged(rule));
		if (futureEntries.length > 0) {
			const futureSection = containerEl.createDiv({ cls: 'fit-obsidian-future-paths' });
			futureSection.createDiv({ text: 'Unrecognized rules', cls: 'fit-obsidian-custom-heading' });
			const dataJsonPath = this.plugin.manifest.dir
				? `${this.plugin.manifest.dir}/data.json`
				: '.obsidian/plugins/fit/data.json';
			const noteEl = futureSection.createDiv({ cls: 'fit-obsidian-future-note' });
			noteEl.createSpan({ text: 'These paths have a sync rule this version of FIT cannot configure. They are treated as ignored until reconfigured or removed in ' });
			noteEl.createEl('code', { text: dataJsonPath });
			noteEl.createSpan({ text: '.' });
			const ul = futureSection.createEl('ul', { cls: 'fit-obsidian-future-list' });
			for (const [path] of futureEntries) {
				ul.createEl('li', { text: path.replace('.obsidian/', ''), cls: 'fit-obsidian-path-readonly' });
			}
		}
	};

	noticeConfigBlock = () => {
		const {containerEl} = this;
		const groupEl = containerEl.createDiv({cls: "fit-notice-group"});
		groupEl.createDiv({text: "Notice display", cls: "fit-notice-group-heading"});

		const makeItem = (
			name: string,
			getValue: () => boolean,
			setValue: (v: boolean) => Promise<void>,
			renderPreview: (el: HTMLElement) => void
		) => {
			const item = groupEl.createDiv({cls: "fit-notice-radio-item"});
			item.createDiv({text: name, cls: "fit-notice-radio-name"});

			const radioRow = item.createDiv({cls: "fit-notice-radio-row"});
			const groupName = `fit-radio-${name.replace(/\W+/g, "-").toLowerCase()}`;

			const showLabel = radioRow.createEl("label", {cls: "fit-notice-radio-option"});
			const showInput = showLabel.createEl("input");
			showInput.type = "radio";
			showInput.name = groupName;
			showInput.checked = getValue();
			showLabel.createSpan({text: "Show notice"});

			const hideLabel = radioRow.createEl("label", {cls: "fit-notice-radio-option"});
			const hideInput = hideLabel.createEl("input");
			hideInput.type = "radio";
			hideInput.name = groupName;
			hideInput.checked = !getValue();
			hideLabel.createSpan({text: "Don't show"});

			const previewEl = item.createDiv({cls: "fit-notice-preview-content"});
			if (getValue()) {
				renderPreview(previewEl);
			} else {
				previewEl.hide();
			}

			showInput.addEventListener("change", async () => {
				await setValue(true);
				previewEl.empty();
				renderPreview(previewEl);
				previewEl.show();
			});
			hideInput.addEventListener("change", async () => {
				await setValue(false);
				previewEl.hide();
			});
		};

		makeItem(
			"File changes",
			() => this.plugin.settings.notifyChanges,
			async (v) => { this.plugin.settings.notifyChanges = v; await this.plugin.saveSettings(); },
			(el) => {
				el.createDiv({text: "Remote changes", cls: "file-changes-heading"});
				el.createDiv({text: "Added", cls: "file-changes-subheading"});
				el.createEl("li", {text: "notes/example.md", cls: "file-update-row file-ADDED"});
				el.createDiv({text: "Modified", cls: "file-changes-subheading"});
				el.createEl("li", {text: "journal/today.md", cls: "file-update-row file-MODIFIED"});
			}
		);

		makeItem(
			"Change conflicts",
			() => this.plugin.settings.notifyConflicts,
			async (v) => { this.plugin.settings.notifyConflicts = v; await this.plugin.saveSettings(); },
			(el) => {
				el.createDiv({text: "Change conflicts:", cls: "file-changes-subheading"});
				const headerRow = el.createDiv({cls: "file-conflict-row"});
				headerRow.createDiv().setText("Local");
				headerRow.createDiv();
				headerRow.createDiv().setText("Remote");
				const row = el.createDiv({cls: "file-conflict-row"});
				row.createDiv({cls: "file-conflict-change"});
				row.createDiv().setText("ideas/meeting-notes.md");
				row.createDiv({cls: "file-conflict-delete"});
			}
		);

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
		const branch_dropdown = containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		const link_el = containerEl.querySelector('.link-desc') as HTMLElement;

		if (refreshFrom === "repo(0)") {
			// Guard: Cannot fetch from API without githubConnection
			if (!this.plugin.githubConnection) {
				this.plugin.logger.log('[FitSettings] Cannot refresh repos without PAT token');
				return;
			}

			// Fetch owners and update owner suggestions
			try {
				this.suggestedOwners = await this.plugin.githubConnection.getAccessibleOwners();
				if (this.ownerSuggest) {
					this.ownerSuggest.updateSuggestions(this.suggestedOwners);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Could not fetch accessible owners: ${errorMsg}`, { error });
				this.suggestedOwners = [];
				if (this.ownerSuggest) {
					this.ownerSuggest.updateSuggestions([]);
				}
			}

			// Fetch repos for current owner and update repo suggestions
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
			if (this.repoSuggest) {
				this.repoSuggest.updateSuggestions(this.existingRepos);
			}
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
				// Capture values at call time so we can detect stale results from
				// user typing the repo name while a debounced fetch is in-flight
				const ownerAtCall = this.plugin.settings.owner;
				const repoAtCall = this.plugin.settings.repo;

				try {
					const latestBranches = await this.plugin.githubConnection.getBranches(ownerAtCall, repoAtCall);

					// Guard: owner or repo changed while the API request was in-flight — discard stale result
					if (ownerAtCall !== this.plugin.settings.owner || repoAtCall !== this.plugin.settings.repo) {
						return;
					}

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
					// If owner/repo changed during the fetch, the error is from a stale partial value — discard silently
					if (ownerAtCall !== this.plugin.settings.owner || repoAtCall !== this.plugin.settings.repo) {
						return;
					}

					// Repository not found or inaccessible - clear branch dropdown
					branch_dropdown.empty();
					this.existingBranches = [];
					// Only log unexpected errors; 404s are expected as user types incomplete repo names
					if (!(error instanceof VaultError && error.type === 'remote_not_found')) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						this.plugin.logger.log(`[FitSettings] Could not fetch branches for ${ownerAtCall}/${repoAtCall}: ${errorMsg}`, { error });
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
			branch_dropdown.empty();
			if (this.plugin.settings.branch) {
				branch_dropdown.add(new Option(this.plugin.settings.branch, this.plugin.settings.branch));
			}
			link_el.innerText = this.getLatestLink();
		}

		if (refreshFrom === "withCache") {
			// Update suggest instances with cached data
			if (this.ownerSuggest) {
				this.ownerSuggest.updateSuggestions(this.suggestedOwners);
			}
			if (this.repoSuggest) {
				this.repoSuggest.updateSuggestions(this.existingRepos);
			}

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
		this.obsidianSyncBlock();
		this.noticeConfigBlock();
		this.refreshFields("withCache");
	}
}
