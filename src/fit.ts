import { LocalStores, FitSettings } from "main"
import { Vault } from "obsidian"
import { Octokit } from "@octokit/core"

type TreeNode = {path: string, mode: string, type: string, sha: string | null}

export interface IFit {
    owner: string
    repo: string
    branch: string
    headers: {[k: string]: string}
    deviceName: string
    localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vault: Vault
    fileSha1: (path: string) => Promise<string>
    getTree: (tree_sha: string) => Promise<TreeNode[]>
    getRef: (ref: string) => Promise<string>
    getCommitTreeSha: (ref: string) => Promise<string>
    getRemoteTreeSha: (tree_sha: string) => Promise<{[k:string]: string}>
    createBlob: (content: string, encoding: string) =>Promise<string>
    createTreeNodeFromFile: ({path, type, extension}: {path: string, type: string, extension?: string}) => Promise<TreeNode>
    createCommit: (treeSha: string, parentSha: string) =>Promise<string>
    updateRef: (sha: string, ref: string) => Promise<string>
    getBlob: (file_sha:string) =>Promise<string>
}

export class Fit implements IFit {
    owner: string
    repo: string
    auth: string | undefined
    branch: string
    headers: {[k: string]: string}
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
        this.headers = {
            "If-None-Match": '', // Hack to disable caching which leads to inconsistency for read after write https://github.com/octokit/octokit.js/issues/890
            'X-GitHub-Api-Version': '2022-11-28'
        }
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

    async getRef(ref: string): Promise<string> {
        const response = await this.octokit.request(
            `GET /repos/${this.owner}/${this.repo}/git/ref/${ref}`, {
                owner: this.owner,
                repo: this.repo,
                ref: ref,
                headers: this.headers
        })
        return response.data.object.sha
    }

    // Get the sha of the latest commit in the default branch (set by user in setting)
    async getLatestRemoteCommitSha(ref = `heads/${this.branch}`): Promise<string> {
        return await this.getRef(ref)
    }

    // ref Can be a commit SHA, branch name (heads/BRANCH_NAME), or tag name (tags/TAG_NAME), refers to https://git-scm.com/book/en/v2/Git-Internals-Git-References
    async getCommitTreeSha(ref: string): Promise<string> {
        const {data: commit} =  await this.octokit.request( `GET /repos/${this.owner}/${this.repo}/commits/${ref}`, {
            owner: this.owner,
            repo: this.repo,
            ref,
            headers: this.headers
        })
        return commit.commit.tree.sha
    }

    async getTree(tree_sha: string): Promise<TreeNode[]> {
        const { data: tree } =  await this.octokit.request(`GET /repos/${this.owner}/${this.repo}/git/trees/${tree_sha}`, {
            owner: this.owner,
            repo: this.repo,
            tree_sha,
            recursive: 'true',
            headers: this.headers
        })
        return tree.tree
    }

    // get the remote tree sha in the format compatible with local store
    async getRemoteTreeSha(tree_sha: string): Promise<{[k:string]: string}> {
        const remoteTree = await this.getTree(tree_sha)
        const remoteSha = Object.fromEntries(remoteTree.map((node: TreeNode) : [string, string] | null=>{
            // currently ignoring directory changes, if you'd like to upload a new directory, a quick hack would be creating an empty file inside
            if (node.type=="blob") {
                if (!node.path || !node.sha) {
                    throw new Error("Path or sha not found for blob node in remote");
                }
                return [node.path, node.sha]
            }
            return null
        }).filter(Boolean) as [string, string][])
        return remoteSha
    }

    async createBlob(content: string, encoding: string): Promise<string> {
        const {data: blob} = await this.octokit.request(`POST /repos/${this.owner}/${this.repo}/git/blobs`, {
            owner: this.owner,
            repo: this.repo,
            content, 
            encoding,
            headers: this.headers     
        })
        return blob.sha
    }


    async createTreeNodeFromFile({path, type, extension}: {path: string, type: string, extension?: string}): Promise<TreeNode> {
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
		const blobSha = await this.createBlob(content, encoding)
		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blobSha,
		}
	}

    async createTree(
        treeNodes: Array<TreeNode>,
        base_tree_sha: string): 
        Promise<string> {
        const {data: newTree} = await this.octokit.request(`POST /repos/${this.owner}/${this.repo}/git/trees`, {
            owner: this.owner,
            repo: this.repo,
            tree: treeNodes,
            base_tree: base_tree_sha,
            headers: this.headers
        })
        return newTree.sha
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async createCommit(treeSha: string, parentSha: string): Promise<string> {
        const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`
        const { data: createdCommit } = await this.octokit.request(`POST /repos/${this.owner}/${this.repo}/git/commits` ,{
            owner: this.owner,
            repo: this.repo,
            message,
            tree: treeSha,
            parents: [parentSha],
            headers: this.headers
        })
        return createdCommit.sha
    }

    async updateRef(sha: string, ref = `heads/${this.branch}`): Promise<string> {
        const { data:updatedRef } = await this.octokit.request(`PATCH /repos/${this.owner}/${this.repo}/git/refs/${ref}`, {
            owner: this.owner,
            repo: this.repo,
            ref,
            sha,
            headers: this.headers
        })
        return updatedRef.object.sha
    }

    async getBlob(file_sha:string): Promise<string> {
        const { data: blob } = await this.octokit.request(`GET /repos/${this.owner}/${this.repo}/git/blobs/${file_sha}`, {
            owner: this.owner,
            repo: this.repo,
            file_sha,
            headers: this.headers
        })
        return blob.content
    }
}