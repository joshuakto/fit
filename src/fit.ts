import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods"
import { MyPluginSettings } from "main"
import { Octokit } from "octokit"

export interface IFit {
    owner: string
    repo: string
    branch: string
    deviceName: string
    octokit: Octokit
    fileSha1: (path: string) => Promise<string>
    getTree: (tree_sha: string) => Promise<RestEndpointMethodTypes["git"]["getTree"]["response"]>
}

export class Fit implements IFit {
    owner: string
    repo: string
    auth: string | undefined
    branch: string
    deviceName: string
    octokit: Octokit

    constructor(setting: MyPluginSettings) {
        this.owner = setting.owner
        this.repo = setting.repo
        this.branch = setting.branch
        this.deviceName = setting.deviceName
        this.octokit = new Octokit({auth: setting.pat})
    }

    async fileSha1(fileContent: string): Promise<string> {
        const enc = new TextEncoder();
        const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(fileContent))
        const hashArray = Array.from(new Uint8Array(hashBuf));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    async getRef(ref: string): Promise<RestEndpointMethodTypes["git"]["getRef"]["response"]> {
        return this.octokit.rest.git.getRef({
            owner: this.owner,
            repo: this.repo,
            ref,
            // Hack to disable caching which leads to inconsistency for read after write https://github.com/octokit/octokit.js/issues/890
            headers: {
                "If-None-Match": ''
            }
        })
    }

    async getCommit(commit_sha: string): Promise<RestEndpointMethodTypes["git"]["getCommit"]["response"]> {
        return this.octokit.rest.git.getCommit({
            owner: this.owner,
            repo: this.repo,
            commit_sha,
            // Hack to disable caching which leads to inconsistency for read after write https://github.com/octokit/octokit.js/issues/890
            headers: {
                "If-None-Match": ''
            }
        })
    }

    async getTree(tree_sha: string): Promise<RestEndpointMethodTypes["git"]["getTree"]["response"]> {
        const tree =  await this.octokit.rest.git.getTree({
            owner: this.owner,
            repo: this.repo,
            tree_sha,
            recursive: 'true'
        })
        return tree
    }

    async createTree(
        treeNode: RestEndpointMethodTypes["git"]["createTree"]["parameters"]["tree"], base_tree_sha: string): 
        Promise<RestEndpointMethodTypes["git"]["createTree"]["response"]> {
        return await this.octokit.rest.git.createTree({
            owner: this.owner,
            repo: this.repo,
            tree: treeNode,
            base_tree: base_tree_sha
        })
    }

    async updateRef(ref: string, sha: string): Promise<RestEndpointMethodTypes["git"]["updateRef"]["response"]> {
        return await this.octokit.rest.git.updateRef({
            owner: this.owner,
            repo: this.repo,
            ref,
            sha
        })
    }

    async getBlob(file_sha:string): Promise<RestEndpointMethodTypes["git"]["getBlob"]["response"]> {
        return await this.octokit.rest.git.getBlob({
            owner: this.owner,
            repo: this.repo,
            file_sha
        })
    }
}