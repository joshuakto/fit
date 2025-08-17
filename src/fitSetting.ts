import FitPlugin, { DEFAULT_REPOSITORY, SyncSetting, DEFAULT_LOCAL_STORE } from "main";
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { difference, intersection, setEqual } from "./utils";

export default class FitSettingTab extends PluginSettingTab {
    plugin: FitPlugin;
    // authenticating: boolean;
    authUserAvatar: HTMLDivElement;
    authUserHandle: HTMLSpanElement;
    // patSetting: Setting;
    // ownerSetting: Setting;
    // repoSetting: Setting;
    // branchSetting: Setting;
    // syncPathSetting: Setting;
    // existingRepos: Array<string>;
    // existingBranches: Array<string>;
    // repoLink: string;
    // syncPath: string;
    currentSyncIndex: number = 0;

    constructor(app: App, plugin: FitPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        // this.currentSyncIndex = plugin.settings.currentSyncIndex || 0;
        // this.repoLink = this.getLatestLink();
        // this.authenticating = false;
        // this.existingRepos = [];
        // this.existingBranches = [];
    }

    getCurrentSyncSetting(): SyncSetting {
        return this.plugin.storage.repo[this.currentSyncIndex].settings;
    }

    getLatestLink = (): string => {
        const currentSetting = this.getCurrentSyncSetting();
        const {owner, repo, branch} = currentSetting;
        if (owner.length > 0 && repo.length > 0 && branch.length > 0) {
            return `https://github.com/${owner}/${repo}/tree/${branch}`;
        }
        return "";
    }

    async githubUserInfoBlock() {
        const {containerEl} = this;
        const currentSetting = this.getCurrentSyncSetting();

        const {folders, files} = await this.plugin.vaultOps.getAllInVault()

        new Setting(containerEl).setHeading()
            .setName(`GitHub user info (Repository ${this.currentSyncIndex + 1})`)

        new Setting(containerEl)
            .setName('Github username')
            .setDesc('Enter your name on Github')
            .addText(text => text
                .setPlaceholder('GitHub username')
                .setValue(currentSetting.owner)
                .onChange(async (value) => {
                    currentSetting.owner = value;
                    await this.plugin.saveSettings();
                }))

        new Setting(containerEl)
            .setName('Github personal access token')
            .setDesc('Remember to give it access for reading and writing to the storage repo.')
            .addText(text => text
                .setPlaceholder('GitHub personal access token')
                .setValue(currentSetting.pat)
                .onChange(async (value) => {
                    currentSetting.pat = value;
                    await this.plugin.saveSettings();
                }))
            .addExtraButton(button=>button
                .setIcon('external-link')
                .setTooltip("Create a token")
                .onClick(async ()=>{
                    window.open("https://github.com/settings/tokens/new", '_blank');
                }));

        new Setting(containerEl)
            .setName('Device name')
            .setDesc('Sign commit message with this device name.')
            .addText(text => text
                .setPlaceholder('Device name')
                .setValue(currentSetting.deviceName)
                .onChange(async (value) => {
                    currentSetting.deviceName = value;
                    await this.plugin.saveSettings();
                }));

// export interface SyncSetting {
//     pat: string; +
//     owner: string; +
//     avatarUrl: string;
//     repo: string; +
//     branch: string; +
//     syncPath: string; +
//     deviceName: string; +
//     excludes: string[]
// }
        new Setting(containerEl)
            .setName('Repository name')
            .setDesc('Select a repo.')
            .addText(text => text
                .setPlaceholder('Repository')
                .setValue(currentSetting.repo)
                .onChange(async (value) => {
                    currentSetting.repo = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Branch name')
            .setDesc('Select a branch.')
            .addText(text => text
                .setPlaceholder('Branch')
                .setValue(currentSetting.branch)
                .onChange(async (value) => {
                    currentSetting.branch = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync path')
            .setDesc('Select a local path to sync with the repo. If the field is empty, the entire vault will be synced.')
            .addText(async (text) => {
                text.setPlaceholder('Enter folder path')
                    .setValue(currentSetting.syncPath || '')
                    .onChange(async (value) => {
                        if (!folders.contains(value))
                            return

                        currentSetting.syncPath = value;
                        await this.plugin.saveSettings();
                    });

                const dataList = document.createElement('datalist');
                dataList.id = `folder-suggestions`;

                const otherSyncPath = new Set()
                this.plugin.storage.repo.forEach(
                    (el, i) => {
                        if (i == this.currentSyncIndex)
                            return

                        otherSyncPath.add(
                            el.settings.syncPath
                        )
                    }
                )

                const allFolders = new Set(
                    await this.plugin.vaultOps.getFoldersInVault()
                )

                const folders = Array.from(
                    difference(allFolders, otherSyncPath)
                )
                for (let i in folders) {
                    const folder = folders[i]

                    const option = document.createElement('option');
                    option.value = folder;
                    dataList.appendChild(option);
                }

                text.inputEl.setAttribute('list', `folder-suggestions`);
                text.inputEl.parentElement?.appendChild(dataList);
            });

        new Setting(containerEl)
            .setName("View your vault on GitHub")
            .addExtraButton(button => button
                .setTooltip("Open on GitHub")
                .setIcon('external-link')
                .onClick(() => {
                    const link = this.getLatestLink();

                    console.log(`opening ${link}`);
                    window.open(link);
                })
            )
            .descEl.addClass("link-desc");

        new Setting(containerEl)
            .setName('Excluded files/folders')
            .setDesc('Files or folders within sync path that will not be synced')
            .addButton(button => button
                .setButtonText('Add exclusion')
                .setCta()
                .onClick(async () => {
                    if (!currentSetting.excludes) {
                        currentSetting.excludes = [];
                    }
                    currentSetting.excludes.push('');
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const allItems = await this.plugin.vaultOps.getAllInVault();
        const allPaths = [...allItems.folders, ...allItems.files];

        if (currentSetting.excludes?.length > 0) {
            currentSetting.excludes.forEach((exclude, index) => {
                new Setting(containerEl)
                    .setName(`Exclusion ${index + 1}`)
                    // .setDesc('Path relative to sync path')
                    .addText(text => {
                        text.setPlaceholder('path/to/exclude')
                            .setValue(exclude)
                            .onChange(async (value) => {
                                if (!folders.contains(value) && !files.contains(value))
                                    return

                                currentSetting.excludes[index] = value;
                                // TODO и исключения не должны повторяться, но это пофиг
                                await this.plugin.saveSettings();
                            });

                        // Добавляем datalist для автодополнения
                        const dataList = document.createElement('datalist');
                        dataList.id = `exclude-suggestions-${index}`;

                        // Фильтруем пути: только те, которые находятся внутри syncPath (если он задан)
                        let filteredPaths = allPaths;
                        if (currentSetting.syncPath) {
                            filteredPaths = allPaths.filter(path =>
                                path.startsWith(currentSetting.syncPath + '/') ||
                                path === currentSetting.syncPath
                            );
                        }

                        filteredPaths.forEach(path => {
                            const option = document.createElement('option');
                            option.value = path;
                            dataList.appendChild(option);
                        });

                        text.inputEl.setAttribute('list', `exclude-suggestions-${index}`);
                        text.inputEl.parentElement?.appendChild(dataList);
                    })
                    .addButton(button => button
                        .setIcon('trash')
                        .setTooltip('Remove this exclusion')
                        .onClick(async () => {
                            currentSetting.excludes.splice(index, 1);
                            await this.plugin.saveSettings();
                            this.display(); // Перерисовываем после удаления
                        }));
            });
        }

    }

    async getItemsInSyncPath(): Promise<string[]> {
        const currentSetting = this.getCurrentSyncSetting();
        if (!currentSetting.syncPath) return [];

        try {
            const syncPath = currentSetting.syncPath;
            const allItems: string[] = [];

            const all = await this.plugin.vaultOps.getAllInVault()
            for (const file in all) {
                if (syncPath == ""
                    || file.startsWith(syncPath + '/')
                    || file === syncPath)
                {
                    allItems.push(file);
                }
            }

            return allItems.sort();
        } catch (error) {
            console.error("Error getting items in sync path:", error);
            return [];
        }
    }

    localConfigBlock = () => {
        const {containerEl} = this;
        // const currentSetting = this.getCurrentSyncSetting();

        new Setting(containerEl).setHeading().setName("Local configurations");

        new Setting(containerEl)
            .setName("Auto sync")
            .setDesc(`Automatically sync your vault when remote has updates. (Muted: sync in the background without displaying notices, except for file changes and conflicts notice)`)
            .addDropdown(dropdown => {
                dropdown
                .addOption('off', 'Off')
                .addOption('muted', 'Muted')
                .addOption('remind', 'Remind only')
                .addOption('on', 'On')
                .setValue(this.plugin.storage.autoSync ? this.plugin.storage.autoSync : 'off')
                .onChange(async (value) => {
                    this.plugin.storage.autoSync = value as "off" | "muted" | "remind" | "on";
                    checkIntervalSlider.settingEl.addClass(value === "off" ? "clear" : "restore");
                    checkIntervalSlider.settingEl.removeClass(value === "off" ? "restore" : "clear");
                    await this.plugin.saveSettings();
                })
            })

        const checkIntervalSlider = new Setting(containerEl)
            .setName('Auto check interval')
            .setDesc(`Automatically check for remote changes in the background every ${this.plugin.storage.checkEveryXMinutes} minutes.`)
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.storage.checkEveryXMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.storage.checkEveryXMinutes = value;
                    await this.plugin.saveSettings();
                    checkIntervalSlider.setDesc(`Automatically check for remote changes in the background every ${value} minutes.`)
                })
            )

        if (this.plugin.storage.autoSync === "off") {
            checkIntervalSlider.settingEl.addClass("clear")
        }
    }

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
            .setDesc(`${stateTextMap(this.plugin.storage.notifyConflicts, this.plugin.storage.notifyChanges)} after sync.`)
            .addButton(button => {
                button.setButtonText("Change conflicts");
                button.onClick(async () => {
                    const notifyConflicts = !this.plugin.storage.notifyConflicts;
                    this.plugin.storage.notifyConflicts = notifyConflicts;
                    await this.plugin.saveSettings();
                    button.buttonEl.setCssStyles({
                        "background": notifyConflicts ? selectedCol : unselectedColor,
                        "color": notifyConflicts ? selectedTxtCol : unselectedTxtCol,
                    });
                    noticeDisplay.setDesc(`${stateTextMap(notifyConflicts, this.plugin.storage.notifyChanges)} after sync.`);
                });
                button.buttonEl.setCssStyles({
                    "background": this.plugin.storage.notifyConflicts ? selectedCol : unselectedColor,
                    "color": this.plugin.storage.notifyConflicts ? selectedTxtCol : unselectedTxtCol,
                });
            })
            .addButton(button => {
                button.setButtonText("File changes");
                button.onClick(async () => {
                    const notifyChanges = !this.plugin.storage.notifyChanges;
                    this.plugin.storage.notifyChanges = notifyChanges;
                    await this.plugin.saveSettings();
                    button.buttonEl.setCssStyles({
                        "background": notifyChanges ? selectedCol : unselectedColor,
                        "color": notifyChanges ? selectedTxtCol : unselectedTxtCol,
                    });
                    noticeDisplay.setDesc(`${stateTextMap(this.plugin.storage.notifyConflicts, notifyChanges)} after sync.`);
                });
                button.buttonEl.setCssStyles({
                    "background": this.plugin.storage.notifyChanges ? selectedCol : unselectedColor,
                    "color": this.plugin.storage.notifyChanges ? selectedTxtCol : unselectedTxtCol,
                });
            });
    }

    counterRepoBlock = () => {
        const {containerEl} = this;

        new Setting(containerEl)
            .setName('Manage repositories')
            .setDesc('Add or remove repository configurations')
            .addButton(button => button
                .setButtonText('Add Repository')
                .setCta()
                .onClick(async () => {
                    this.plugin.storage.repo.push(DEFAULT_REPOSITORY);
                    await this.plugin.saveSettings();
                    this.display();
                }))
            .addButton(button => button
                .setButtonText('Remove Repository')
                .setWarning()
                .setDisabled(this.plugin.storage.repo.length <= 1)
                .onClick(async () => {
                    if (this.plugin.storage.repo.length > 1) {
                        this.plugin.storage.repo.splice(this.currentSyncIndex, 1);
                        if (this.currentSyncIndex >= this.plugin.storage.repo.length) {
                            this.currentSyncIndex = this.plugin.storage.repo.length - 1;
                        }
                        await this.plugin.saveSettings();
                        this.display();
                    }
                }));

        new Setting(containerEl)
            .setName('Current repository')
            .setDesc('Select which repository configuration to edit')
            .addDropdown(dropdown => {
                this.plugin.storage.repo.forEach((_, index) => {
                    dropdown.addOption(index.toString(), `Repository ${index + 1}`);
                });
                dropdown.setValue(this.currentSyncIndex.toString());
                dropdown.onChange(async (value) => {
                    this.currentSyncIndex = parseInt(value);
                    await this.plugin.saveSettings();
                    this.display();
                });
            });
    }

    resetBlock = () => {
        const {containerEl} = this;

        new Setting(containerEl)
            .setName('Reset settings')
            .setDesc('Remove Sync storage or Settings')
            .addButton(button => button
                .setButtonText('Reset storage')
                .setWarning()
                .onClick(async () => {
                    for (let storage of this.plugin.storage.repo) {
                        storage.localStore = DEFAULT_LOCAL_STORE
                    }
                    // TODO add notice("Done")
                    await this.plugin.saveSettings();
                    this.display();
                }))
            .addButton(button => button
                .setButtonText('Reset Settings')
                .setWarning()
                .onClick(async () => {
                    this.plugin.storage.repo = [DEFAULT_REPOSITORY];
                    // TODO add notice("Done")
                    await this.plugin.saveSettings();
                    this.display();
                }))

    }

    importExport() {
        const {containerEl} = this;

        new Setting(containerEl)
            .setName('Import/Export settings')
            .setDesc('Backup or restore your plugin configuration')
            .setHeading();

        // Текстовое поле для отображения/ввода конфигурации
        const textAreaContainer = containerEl.createDiv('import-export-container');
        const textArea = textAreaContainer.createEl('textarea', {
            attr: {
                placeholder: 'Configuration JSON will appear here...',
                rows: '10',
                style: 'width: 100%; font-family: monospace;'
            },
            cls: 'import-export-textarea'
        });

        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Export to Text Field')
                .setCta()
                .onClick(async () => {
                    this.exportToTextField(textArea);
                }))
            .addButton(button => button
                .setButtonText('Import from Text Field')
                .setWarning()
                .onClick(async () => {
                    await this.importFromTextField(textArea);
                }))
            .addButton(button => button
                .setButtonText('Clear Field')
                .setIcon('trash')
                .onClick(() => {
                    textArea.value = '';
                }));
    }

    private exportToTextField(textArea: HTMLTextAreaElement) {
        try {
            const result: any = structuredClone(this.plugin.storage)
            for(let i in result.repo) {
                delete result.repo[i].localStore
            }

            const settingsJson = JSON.stringify(result, null, 4);

            textArea.value = settingsJson;
            textArea.focus();
            textArea.select();

        }
        catch (error) {
            console.error('Error exporting settings:', error);
            new Notice('Error exporting configuration', 3000);
        }
    }

    private async importFromTextField(textArea: HTMLTextAreaElement) {
        try {
            const jsonContent = textArea.value.trim();

            if (!jsonContent) {
                new Notice('Text field is empty', 3000);
                return;
            }

            const importedSettings = JSON.parse(jsonContent);

            // Валидация импортированных настроек
            if (this.validateImportedSettings(importedSettings)) {
                for (let repo of importedSettings.repo) {
                    repo.localStore = DEFAULT_LOCAL_STORE
                }

                this.plugin.storage = importedSettings
                await this.plugin.saveSettings();

                new Notice('Settings imported successfully!', 3000);

                await this.display();
            } else {
                new Notice('Invalid settings format in text field', 4000);
            }
        }
        catch (error) {
            console.error('Error importing settings from text field:', error);
            new Notice('Error parsing JSON configuration', 4000);
        }
    }

    private validateImportedSettings(settings: any): boolean {
        // Basic validation
        return settings &&
            typeof settings === 'object' &&
            Array.isArray(settings.repo) &&
            settings.repo.length > 0 &&
            settings.repo[0].settings &&
            typeof settings.repo[0].settings === 'object' &&
            'syncPath' in settings.repo[0].settings;
    }

    async display(): Promise<void> {
        const {containerEl} = this;

        containerEl.empty();


        this.localConfigBlock();
        this.noticeConfigBlock();
        containerEl.createEl('hr');

        await this.importExport()
        containerEl.createEl('hr');

        this.counterRepoBlock();
        containerEl.createEl('hr');

        // TODO написать, что тут для allSettings, а не отдельный репозиторий
        // TODO add prune settings exactly for one repo
        this.resetBlock()
        containerEl.createEl('hr');

        await this.githubUserInfoBlock();
    }
}

// class FolderSuggestModal extends SuggestModal<string> {
//     constructor(app: App, private folders: string[], private callback: (folder: string) => void) {
//         super(app);
//     }

//     getSuggestions(query: string): string[] {
//         return this.folders.filter(folder =>
//             folder.toLowerCase().includes(query.toLowerCase())
//         );
//     }

//     renderSuggestion(folder: string, el: HTMLElement) {
//         el.createEl('div', { text: folder });
//     }

//     onChooseSuggestion(folder: string, evt: MouseEvent | KeyboardEvent) {
//         this.callback(folder);
//     }
// }
