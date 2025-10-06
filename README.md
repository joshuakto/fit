# FIT
![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22fit%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)

Sync your files across mobile and desktop devices with one click.

## Community project

This project is a community collaboration. If you'd like to contribute please check out the [Discussions section] on GitHub to suggest or discuss ideas.

[Discussions section]: https://github.com/joshuakto/fit/discussions

## Security review

Users are highly recommended to do a security review of the code of this project before trusting it with their data. You could use an AI tool for that such as Claude Code.

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

## Notes about the first sync
- It is advised to use a new repo for syncing an existing vault, to minimize the chance of file name conflict on the first sync
- If your existing vault or repo is large, the initial sync would take longer and require a good internet connection

## Roadmap
1. Improve user notification
   - allow user to opt in to get list of file changes in Notice
2. Enable integration of other git tools (e.g. gitlab, gitea)

## Relevant plugins
There are other community plugins with more advanced git features, if you need features such as branching of your repo, [Git](https://github.com/denolehov/obsidian-git) is a nice plugin to check out.

There are also other plugins for synchronizing changes such as [Git integration](https://github.com/noradroid/obsidian-git-integration), [GitHub sync](https://github.com/kevinmkchin/Obsidian-GitHub-Sync), and [YAOS](https://github.com/mahyarmirrashed/yaos). However, they do not support mobile yet as of writing this plugin.

[!["Buy Me A Coffee"](https://cdn.buymeacoffee.com/buttons/v2/default-blue.png)](https://www.buymeacoffee.com/joshuakto)

## Developer Documentation

For developers interested in contributing to FIT or understanding its architecture, comprehensive documentation is available in the [docs/](https://github.com/joshuakto/fit/tree/main/docs) directory in GitHub.

## Acknowledgements
 - This plugin used [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin) as a template.
 - This plugin uses [Octokit](https://github.com/octokit/core.js/) to interface with GitHub rest api across devices.
