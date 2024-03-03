import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods"
import { LocalStores, FitSettings } from "main"
import { Vault } from "obsidian"
import { Octokit } from "octokit"


export interface IFit {
    owner: string
    repo: string
    branch: string
    deviceName: string
    localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vault: Vault
    fileSha1: (path: string) => Promise<string>
    getTree: (tree_sha: string) => Promise<RestEndpointMethodTypes["git"]["getTree"]["response"]>
}

export class Fit implements IFit {
    owner: string
    repo: string
    auth: string | undefined
    branch: string
    deviceName: string
    localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vault: Vault


    constructor(setting: FitSettings, localStores: LocalStores, vault: Vault) {
        this.loadSettings(setting)
        this.loadLocalStore(localStores)
        this.vault = vault
    }
    
    loadSettings(setting: FitSettings) {
        this.owner = setting.owner
        this.repo = setting.repo
        this.branch = setting.branch
        this.deviceName = setting.deviceName
        this.octokit = new Octokit({auth: setting.pat})
    }
    
    loadLocalStore(localStore: LocalStores) {
        this.localSha = localStore.localSha
        this.lastFetchedCommitSha = localStore.lastFetchedCommitSha
        this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha
    }
    
    async fileSha1(fileContent: string): Promise<string> {
        const enc = new TextEncoder();
        const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(fileContent))
        const hashArray = Array.from(new Uint8Array(hashBuf));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    async computeFileLocalSha(path: string): Promise<string> {
		if (!await this.vault.adapter.exists(path)) {
			throw new Error(`Attempting to compute local sha for ${path}, but file not found.`);
		}
		// compute sha1 based on path and file content
		const localFile = await this.vault.adapter.read(path)
		return await this.fileSha1(path + localFile)
	}

	async computeLocalSha(): Promise<{[k:string]:string}> {
		const paths = this.vault.getFiles().map(f=>f.path)
		return Object.fromEntries(
			await Promise.all(
				paths.map(async (p: string): Promise<[string, string]> =>{
					return [p, await this.computeFileLocalSha(p)]
				})
			)
		)
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

    // Get the sha of the latest commit in the default branch (set by user in setting)
    async getLatestRemoteCommitSha(): Promise<string> {
        const {data: latestRef} = await this.getRef(`heads/${this.branch}`)
        return latestRef.object.sha
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

    // get the remote tree sha in the format compatible with local store
    async getRemoteTreeSha(tree_sha: string): Promise<{[k:string]: string}> {
        const {data: remoteTree} = await this.getTree(tree_sha)
        const remoteSha = Object.fromEntries(remoteTree.tree.map((node) : [string, string] | null=>{
            // currently ignoreing directory changes
            if (node.type=="blob") {
                if (!node.path || !node.sha) {
                    throw new Error("Path and sha not found for blob node in remote");
                }
                return [node.path, node.sha]
            }
            return null
        }).filter(Boolean) as [string, string][])
        return remoteSha
    }

    async createBlob(content: string, encoding: string): Promise<RestEndpointMethodTypes["git"]["createBlob"]["response"]> {
        const blob = await this.octokit.rest.git.createBlob({
            owner: this.owner,
            repo: this.repo,
            content, encoding
        })
        return blob
    }

    async createTreeNodeFromFile(
		{path, type, extension}: {path: string, type: string, extension?: string}): 
		Promise<RestEndpointMethodTypes["git"]["createTree"]["parameters"]["tree"][number]> {
		if (type === "deleted") {
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null
			}
		}
		if (!this.vault.adapter.exists(path)) {
			throw new Error("Unexpected error: attempting to createBlob for non-existent file, please file an issue on github with info to reproduce the issue.");
		}
		let encoding: string;
		let content: string 
		if (extension && ["pdf", "png", "jpeg"].includes(extension)) {
			encoding = "base64"
			const fileArrayBuf = await this.vault.adapter.readBinary(path)
			const uint8Array = new Uint8Array(fileArrayBuf);
			let binaryString = '';
			for (let i = 0; i < uint8Array.length; i++) {
				binaryString += String.fromCharCode(uint8Array[i]);
			}
			content = btoa(binaryString);
		} else {
			encoding = 'utf-8'
			content = await this.vault.adapter.read(path)
		}
		const blob = await this.createBlob(content, encoding)
		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blob.data.sha
		}
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

    async createCommit(treeSha: string, parentSha: string): Promise<RestEndpointMethodTypes["git"]["createCommit"]["response"]> {
        const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`
        return await this.octokit.rest.git.createCommit({
            owner: this.owner,
            repo: this.repo,
            message,
            tree: treeSha,
            parents: [parentSha]
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