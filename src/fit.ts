import { MyPluginSettings } from "main"
import { Octokit } from "octokit"

export interface IFit {
    repo: string
    octokit: Octokit
    auth: string | undefined
    fileSha1: (path: string) => Promise<string>
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

    async fileSha1(fileContent: string): Promise<string> {
        const enc = new TextEncoder();
        const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(fileContent))
        const hashArray = Array.from(new Uint8Array(hashBuf));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }
}