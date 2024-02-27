import { MyPluginSettings } from "main"
import { Octokit } from "octokit"

export interface IFit {
    repo: string
    octokit: Octokit
    auth: string | undefined
}

export class Fit implements IFit {
    repo: string
    octokit: Octokit
    auth: string | undefined

    constructor(repo: string, setting: MyPluginSettings) {
        // this.auth for debugging, remove when publishing plugin
        this.auth = setting.pat
        this.octokit = new Octokit({auth: setting.pat})
        this.repo = repo
    }
}