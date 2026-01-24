import { LocalStores, Repository, SyncSetting } from "main"
import { Octokit } from "@octokit/core"
import { RECOGNIZED_TXT_EXT, compareSha, extractExtension } from "./utils"
import { VaultOperations } from "./vaultOps"
import { LocalChange, LocalFileStatus, RemoteChange, RemoteChangeType } from "./fitTypes"
import { arrayBufferToBase64 } from "obsidian"
import { conflictResolutionFolder, rootFitFolder } from "./const"

type AddToLocal = {
    path: string;
    content: string;
}


export type TreeNode = {
    path: string,
    mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined,
    type: "commit" | "blob" | "tree" | undefined,
    sha: string | null}

type OctokitCallMethods = {
    // getUser: () => Promise<{owner: string, avatarUrl: string}>
    getRepos: () => Promise<string[]>
    getRef: (ref: string) => Promise<string>
    getTree: (tree_sha: string) => Promise<TreeNode[]>
    getCommitTreeSha: (ref: string) => Promise<string>
    getRemoteTreeSha: (tree_sha: string) => Promise<{[k:string]: string}>
    createBlob: (content: string, encoding: string) =>Promise<string>
    createTreeNodeFromFile: ({path, status, extension}: LocalChange, remoteTree: TreeNode[]) => Promise<TreeNode|null>
    createCommit: (treeSha: string, parentSha: string) =>Promise<string>
    updateRef: (sha: string, ref: string) => Promise<string>
    getBlob: (file_sha:string) =>Promise<string>
}

export interface IFit extends OctokitCallMethods{
    owner: string
    repo: string
    branch: string
    headers: {[k: string]: string}
    deviceName: string
    localSha: Record<string, string>
    lastFetchedCommitSha: string | null
    lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vaultOps: VaultOperations
    fileSha1: (path: string) => Promise<string>
}

// Define a custom HttpError class that extends Error
export class OctokitHttpError extends Error {
    status: number;
    source: keyof OctokitCallMethods

    constructor(message: string, status: number, source: keyof OctokitCallMethods) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.source = source
    }
}

export class Fit implements IFit {
    owner: string
    repo: string
    auth: string | undefined
    branch: string
    syncPath: string
    headers: {[k: string]: string}
    deviceName: string
    localSha: Record<string, string>
    lastFetchedCommitSha: string | null
    lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vaultOps: VaultOperations
    excludes: string[]


    constructor(repo: Repository, vaultOps: VaultOperations) {
        this.loadSettings(repo)
        this.vaultOps = vaultOps
        this.headers = {
            // Hack to disable caching which leads to inconsistency for
            // read after write https://github.com/octokit/octokit.js/issues/890
            "If-None-Match": '',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    }

    loadSettings(repo: Repository) {
        const {settings, localStore} = repo
        this.repo = settings.repo
        this.owner = settings.owner
        this.branch = settings.branch
        this.excludes = settings.excludes
        this.syncPath = settings.syncPath
        this.deviceName = settings.deviceName

        this.octokit = new Octokit({auth: settings.pat})

        // Также нужно сохранить другие поля если они используются в классе Fit
        // this.pat = setting.pat;
        // this.avatarUrl = setting.avatarUrl;
        // this.syncPath = setting.syncPath;

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

    private async computeFileLocalSha(path: string): Promise<string|null> {
        const fullPath = this.syncPath + path

        // compute sha1 based on path and file content
        let content: string;

        // TODO refactor
        // Note: only support TFile now, investigate need for supporting TFolder later on
        const file = await this.vaultOps.getTFile(fullPath)
        if (file) {
            if (RECOGNIZED_TXT_EXT.includes(file.extension)) {
                content = await this.vaultOps.vault.read(file)
            } else {
                content = arrayBufferToBase64(await this.vaultOps.vault.readBinary(file))
            }
        }
        else {
            const extension = extractExtension(path)
            if (!extension || !RECOGNIZED_TXT_EXT.includes(extension)) {
                content = arrayBufferToBase64(
                    await this.vaultOps.vault.adapter.readBinary(fullPath)
                )
            } else {
                content = await this.vaultOps.vault.adapter.read(fullPath)
            }
        }

        return await this.fileSha1(path + content)
    }

    async computeLocalSha(): Promise<{[k:string]:string}> {
        const allPaths = await this.vaultOps.getFilesInVault()
        const paths = []
        for (let path of allPaths) {
            // TODO нужны ли мне эти файлы в будущем?
            let isExcluded = path.startsWith(rootFitFolder)
                || !path.startsWith(this.syncPath)
                || this.excludes.contains(path)

                || this.excludes.some(
                        exclude => path.startsWith(exclude)
                            && !this.syncPath.startsWith(exclude) // NOTE if one syncPath nested in another syncPath
                    );

            const result = path.replace(this.syncPath, "")

            if (!isExcluded)
                paths.push(result)
        }
        const asyncCompute = paths.map(
            async (path) => {
                const sha = await this.computeFileLocalSha(path)
                return [path, sha]
            }
        )

        const computed = await Promise.all(asyncCompute)
        const result = computed.filter(el => !!el[1])

        return Object.fromEntries(result)
    }

    async remoteUpdated(): Promise<{remoteCommitSha: string, updated: boolean}> {
        const remoteCommitSha = await this.getRef()
        return {remoteCommitSha, updated: remoteCommitSha !== this.lastFetchedCommitSha}
    }

    async getLocalChanges(currentLocalSha?: Record<string, string>): Promise<LocalChange[]> {
        if (!currentLocalSha) {
            currentLocalSha = await this.computeLocalSha()
        }
        const localChanges = compareSha(currentLocalSha, this.localSha, "local")
        return localChanges
    }

    async getRemoteChanges(remoteTreeSha: {[k: string]: string}): Promise<RemoteChange[]> {
        const remoteChanges = compareSha(remoteTreeSha, this.lastFetchedRemoteSha, "remote")
        return remoteChanges
    }

    getClashedChanges(localChanges: LocalChange[], remoteChanges:RemoteChange[]):
        Array<{path: string, localStatus: LocalFileStatus, remoteStatus: RemoteChangeType}>
    {
        // TODO ffezt_checking здесь вроде несовместимые изменения появляются

        const localChangePaths = localChanges.map(
            c => c.path.replace(this.syncPath, '')
        )
        const remoteChangePaths = remoteChanges.map(c=>c.path)

        const clashedFiles = localChangePaths.map(
            (path, localIndex) => {
                const remoteIndex = remoteChangePaths.indexOf(path)
                if (remoteIndex !== -1) {
                    return {path, localIndex, remoteIndex}
                }
                return null
            }
        ).filter(Boolean) as Array<{path: string, localIndex: number, remoteIndex:number}>

        return clashedFiles.map(
            ({path, localIndex, remoteIndex}) => {
                return {
                    path,
                    localStatus: localChanges[localIndex].status,
                    remoteStatus: remoteChanges[remoteIndex].status
                }
            })
    }

    async getRepos(): Promise<string[]> {
        const allRepos: string[] = [];
        let page = 1;
        const perPage = 100; // Set to the maximum value of 100

        try {
            let hasMorePages = true;
            while (hasMorePages) {
                const { data: response } = await this.octokit.request(
                    `GET /user/repos`, {
                    affiliation: "owner",
                    headers: this.headers,
                    per_page: perPage, // Number of repositories to import per page (up to 100)
                    page: page
                }
                );
                allRepos.push(...response.map(r => r.name));

                // Make sure you have the following pages
                if (response.length < perPage) {
                    hasMorePages = false; // Exit when there are no more repositories
                }

                page++; // Go to the next page
            }

            return allRepos;
        } catch (error) {
            throw new OctokitHttpError(error.message, error.status, "getRepos");
        }
    }

    async getBranches(): Promise<string[]> {
        try {
            const {data: response} = await this.octokit.request(
                `GET /repos/{owner}/{repo}/branches`,
                {
                    owner: this.owner,
                    repo: this.repo,
                    headers: this.headers
            })
            return response.map(r => r.name)
        } catch (error) {
            throw new OctokitHttpError(error.message, error.status, "getRepos");
        }
    }

    // Get the sha of the latest commit in the default branch (set by user in setting)
    async getRef(ref: string = `heads/${this.branch}`): Promise<string> {
        try {
            const {data: response} = await this.octokit.request(
                `GET /repos/{owner}/{repo}/git/ref/{ref}`, {
                    owner: this.owner,
                    repo: this.repo,
                    ref: ref,
                    headers: this.headers
            })
            return response.object.sha
        } catch (error) {
            throw new OctokitHttpError(error.message, error.status, "getRef");
        }
    }

    // ref Can be a commit SHA, branch name (heads/BRANCH_NAME), or tag name (tags/TAG_NAME),
    // refers to https://git-scm.com/book/en/v2/Git-Internals-Git-References
    async getCommitTreeSha(ref: string): Promise<string> {
        const {data: commit} =  await this.octokit.request(
            `GET /repos/{owner}/{repo}/commits/{ref}`, {
            owner: this.owner,
            repo: this.repo,
            ref,
            headers: this.headers
        })
        return commit.commit.tree.sha
    }

    async getTree(tree_sha: string): Promise<TreeNode[]> {
        const { data: tree } =  await this.octokit.request(
            `GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
            owner: this.owner,
            repo: this.repo,
            tree_sha,
            recursive: 'true',
            headers: this.headers
        })
        return tree.tree as TreeNode[]
    }

    // get the remote tree sha in the format compatible with local store
    async getRemoteTreeSha(tree_sha: string): Promise<{[k:string]: string}> {
        const remoteTree = await this.getTree(tree_sha)
        const remoteSha = Object.fromEntries(remoteTree.map((node: TreeNode) : [string, string] | null=>{
            // currently ignoring directory changes, if you'd like to upload a new directory,
            // a quick hack would be creating an empty file inside
            if (node.type=="blob") {
                if (!node.path || !node.sha) {
                    throw new Error("Path or sha not found for blob node in remote");
                }
                // ignore changes in the _fit/ directory
                if (node.path.startsWith(conflictResolutionFolder)) {return null}
                return [node.path, node.sha]
            }
            return null
        }).filter(Boolean) as [string, string][])
        return remoteSha
    }

    async createBlob(content: string, encoding: string): Promise<string> {
        const {data: blob} = await this.octokit.request(
            `POST /repos/{owner}/{repo}/git/blobs`, {
            owner: this.owner,
            repo: this.repo,
            content,
            encoding,
            headers: this.headers
        })
        return blob.sha
    }


    async createTreeNodeFromFile({path, status, extension}: LocalChange, remoteTree: Array<TreeNode>): Promise<TreeNode|null> {
        if (status === "deleted") {
            // skip creating deletion node if file not found on remote
            if (remoteTree.every(node => node.path !== path)) {
                return null
            }
            return {
                path,
                mode: '100644',
                type: 'blob',
                sha: null
            }
        }
        const fullPath = this.syncPath + path
        // const file = await this.vaultOps.getTFile(this.syncPath + path)
        // if (!file)
        //     return null

        let encoding: string;
        let content: string
        // TODO check whether every files including md can be read using readBinary to reduce code complexity
        // TODO есть функция, getFileEncoding
        if (extension && !RECOGNIZED_TXT_EXT.includes(extension)) {
            encoding = "base64"

            const fileArrayBuf = await this.vaultOps.vault.adapter.readBinary(fullPath)
            // const fileArrayBuf = await this.vaultOps.vault.readBinary(file)
            const uint8Array = new Uint8Array(fileArrayBuf);
            let binaryString = '';
            for (let i = 0; i < uint8Array.length; i++) {
                binaryString += String.fromCharCode(uint8Array[i]);
            }
            content = btoa(binaryString);
        } else {
            encoding = 'utf-8'
            // content = await this.vaultOps.vault.read(file)
            content = await this.vaultOps.vault.adapter.read(fullPath)
        }
        const blobSha = await this.createBlob(content, encoding)
        // skip creating node if file found on remote is the same as the created blob
        if (remoteTree.some(node => node.path === path && node.sha === blobSha)) {
            return null
        }
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
            const {data: newTree} = await this.octokit.request(
                `POST /repos/{owner}/{repo}/git/trees`,
                {
                    owner: this.owner,
                    repo: this.repo,
                    tree: treeNodes,
                    base_tree: base_tree_sha,
                    headers: this.headers
                }
            )
            return newTree.sha
    }

    async createCommit(treeSha: string, parentSha: string): Promise<string> {
        const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`
        const { data: createdCommit } = await this.octokit.request(
            `POST /repos/{owner}/{repo}/git/commits` , {
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
        const { data:updatedRef } = await this.octokit.request(
            `PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
            owner: this.owner,
            repo: this.repo,
            ref,
            sha,
            headers: this.headers
        })
        return updatedRef.object.sha
    }

    async getBlob(file_sha:string): Promise<string> {
        const { data: blob } = await this.octokit.request(
            `GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
            owner: this.owner,
            repo: this.repo,
            file_sha,
            headers: this.headers
        })
        return blob.content
    }

    getAddToLocal(addToLocal_: AddToLocal[]): AddToLocal[] {
        const basepath = this.syncPath
        const addToLocal: AddToLocal[] = structuredClone(addToLocal_)

        return addToLocal.map(
            ({path, content}) => {
                return {
                    path: basepath+path,
                    content
                }
            }
        )
        .filter(
            file => {
                const excludes = this.excludes
                if (!excludes.length)
                    return true
                return excludes.some(
                    exclude => !file.path.startsWith(exclude)
                        || this.syncPath.startsWith(exclude) // NOTE if one syncPath nested in another syncPath
                )
            }
        )
    }

    getDeleteFromLocal(deleteFromLocal_: string[]): string[] {
        const basepath = this.syncPath
        const deleteFromLocal: string[] = structuredClone(deleteFromLocal_)

        return deleteFromLocal
            .map(
                path => basepath + path
            )
            .filter(
                path => {
                    const excludes = this.excludes
                    if (!excludes.length)
                        return true

                    return excludes.some(
                        exclude => !path.startsWith(exclude)
                            || this.syncPath.startsWith(exclude)  // NOTE if one syncPath nested in another syncPath
                    )
                }
            )
    }

}
