# FIT
![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22fit%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)

Sync your files across mobile and desktop devices with one click.

## Community project

This project is a community collaboration. If you'd like to contribute please check out the [Discussions section] on GitHub to suggest or discuss ideas.

[Discussions section]: https://github.com/joshuakto/fit/discussions

## Features
- **Universally supported**: sync your vault across multiple devices, supports both mobile and desktop
- Auto sync is now available 🎉
- One-click to sync your vault
- Conflict resolution: Stores conflicting changes from remote in the local _fit folder so you can resolve conflicts after sync
- Guided setup: **Intuitive** settings, easy to configure even if you are new to GitHub
- Works with existing vaults or repos

**Note:** This plugin is still in beta, please backup your vault before using this plugin.


# Quick demo


![Kapture 2024-03-15 at 17 37 07](https://github.com/joshuakto/fit/assets/34743132/27ea39b7-f54d-4c95-bf40-41972a29c26d)



## Setup
1. Create a personal access token with read/write access to the repo for your vault (refer to [Github: creating a personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token))
2. Once the personal access token is filled in, you can authenticate the user. The GitHub username, list of repositories, and branches will auto-populate.
3. Select a repo and branch and you are ready to sync.
<img width="1100" alt="Screenshot of FIT settings for tokens and repos" src="https://github.com/joshuakto/fit/assets/34743132/3ab3665a-5a78-468c-a936-fcf5fd2a8774">

NOTE: For security, it's recommended to limit the token scope to only the necessary repository for your vault and avoid sharing your entire plugin settings file that contains this token.

## How Sync Works

### What gets synced

**✅ Synced files:**
- Regular markdown files (.md)
- Attachments (images, PDFs, etc.)
- Any files in your vault root

**❌ NOT synced (protected paths):**
- `.obsidian/` folder (Obsidian settings and plugins)
- `_fit/` folder (conflict resolution area)
- Hidden files like `.gitignore`, `.env` (not currently supported - see [#92](https://github.com/joshuakto/fit/issues/92) for planned opt-in support)

### Conflict handling

When the same file is modified both locally and remotely, FIT:
- Keeps your local version in place
- Saves the remote version to `_fit/path/to/file.md`
- You can manually compare and merge the versions
- If the same file clashes again before you resolve it, the `_fit/` version is overwritten with the latest remote version (sync doesn't fail)

See [Common Issues](#common-issues) below for detailed conflict resolution steps.

### First sync

- It is advised to use a new repo for syncing an existing vault, to minimize the chance of file name conflict on the first sync
- If your existing vault or repo is large, the initial sync would take longer and require a good internet connection

## 🔒 Security

The FIT maintainers make every effort to protect your security and protect against data loss. However, mistakes can happen. Users are highly recommended to do a security review of the code of this project before trusting it with their data. You could use an AI tool for that such as Claude Code.

You should also take care with security tokens you use to ensure they don't leak, because anyone with access to those can read and write your vault repository even if it's private (or worse if you configure broad unrestricted permissions on your token). In particular, **avoid syncing your .obsidian/ files** with other tools if you don't know what you're doing, and consider adding .gitignore rules to ignore .obsidian/ paths if you'll be syncing anything using git (FIT itself never syncs `.obsidian/` - see [How Sync Works](#how-sync-works)).

## Common Issues

<details>
<summary><b>📁 Empty directories not syncing</b></summary>

**Why:** Git (and GitHub) doesn't track empty directories. This is a fundamental limitation of Git, not a FIT bug.

**Solution:** Add a placeholder file like `_gitkeep` or `README.md` to keep the folder. Empty folders will only sync once they contain files.

</details>

<details>
<summary><b>📦 File size limits - "input too large" errors</b></summary>

**Why:** GitHub API has file size limits (~100MB hard limit, issues with files >10MB).

**Symptoms:** Error messages like "input too large to process" or "File 'X' is too large..."

**Solutions:**
- Move large files (>20MB) outside your vault before syncing
- Manually sync large files to GitHub using other tools (to create them and any time they're modified)
- Add the files to .gitignore to exclude them from sync (once .gitignore is supported, #92)

</details>

<details>
<summary><b>⚠️ Sync conflicts - files in `_fit/` folder</b></summary>

**What happens:** When the same file is modified locally AND on GitHub, FIT saves both versions:
- Your local version stays in place
- The remote version is saved to `_fit/path/to/file.md`

**How to resolve:**
1. Find conflict files in the `_fit/` folder
2. Compare both versions
3. Manually merge the changes you want to keep
4. Delete the `_fit/` version when done
5. Sync again

**Prevention:** Sync regularly (enable auto-sync) and avoid editing the same file on multiple devices simultaneously.

</details>

<details>
<summary><b>🖼️ Images/PDFs showing as corrupted text in GitHub</b></summary>

**Symptoms:** Binary files (JPG, PNG, PDF) appear as gibberish text in GitHub like `����JFIF��...` instead of displaying properly

**Cause:** Bug in v1.4.0-beta.3 where binary files were incorrectly read as text on some platforms

**Solution:**
1. Check file history in GitHub to find bad changes
2. Use git to restore previous versions OR manually copy from history
3. Update to v1.4 stable when available or a different beta version
4. Re-sync - files will upload correctly

**Note:** This only affected beta versions. Images and PDFs sync correctly in v1.4+.

**More info:** See https://github.com/joshuakto/fit/issues/156 about the regression and older "correct format" error.

</details>

## Roadmap

See [CONTRIBUTING.md](https://github.com/joshuakto/fit/blob/main/docs/CONTRIBUTING.md#roadmap--priorities) for current milestone and long-term priorities.

## Relevant plugins
There are other community plugins with more advanced git features, if you need features such as branching of your repo, [Git](https://github.com/denolehov/obsidian-git) is a nice plugin to check out.

There are also other plugins for synchronizing changes such as [Git integration](https://github.com/noradroid/obsidian-git-integration), [GitHub sync](https://github.com/kevinmkchin/Obsidian-GitHub-Sync), and [YAOS](https://github.com/mahyarmirrashed/yaos). However, they do not support mobile yet as of writing this plugin.

[!["Buy Me A Coffee"](https://cdn.buymeacoffee.com/buttons/v2/default-blue.png)](https://www.buymeacoffee.com/joshuakto)

## Developer Documentation

For developers interested in contributing to FIT or understanding its architecture, comprehensive documentation is available in the [docs/](https://github.com/joshuakto/fit/tree/main/docs) directory in GitHub.

## Acknowledgements
 - This plugin used [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin) as a template.
 - This plugin uses [Octokit](https://github.com/octokit/core.js/) to interface with GitHub rest api across devices.
