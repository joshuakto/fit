/**
 * GitHub API Client and Local State Access Layer
 *
 * This module provides low-level access to both local vault storage (via LocalVault)
 * and remote GitHub storage (via Octokit). It serves as the data access layer for
 * the sync engine, providing primitives that higher-level components (FitSync, FitPull,
 * FitPush) use to coordinate synchronization.
 *
 * Architecture Role:
 * - **Data Access Layer**: Abstracts storage operations for both local and remote
 * - **Used by**: FitSync (orchestrator), FitPull (pull operations), FitPush (push operations)
 * - **Uses**: LocalVault (local file operations), Octokit (GitHub API)
 *
 * Key Responsibilities:
 * - GitHub API operations via Octokit with automatic retry on rate limits
 * - Local vault state detection (delegated to LocalVault)
 * - Change detection helpers (comparing local vs remote state)
 * - Binary and text file handling
 *
 * GitHub API Error Handling:
 * - All GitHub operations throw OctokitHttpError with status codes and source method
 * - Automatic retry with exponential backoff for rate limiting (via @octokit/plugin-retry)
 * - Respects 'retry-after' and 'x-ratelimit-*' headers for optimal retry timing
 * - Does not retry client errors (4xx) except specific rate limit cases
 *
 * Future Refactoring Note:
 * - GitHub-specific code should move to src/github/RemoteGitHubVault
 * - Fit should work with IVault abstraction for both local and remote
 */

import { LocalStores, FitSettings } from "main";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { RECOGNIZED_BINARY_EXT, compareSha, EMPTY_TREE_SHA } from "./utils";
import { VaultOperations } from "./vaultOps";
import { LocalChange, LocalFileStatus, RemoteChange, RemoteChangeType } from "./fitTypes";
import { arrayBufferToBase64 } from "obsidian";
import { SyncError } from "./syncResult";

/**
 * Represents a node in GitHub's git tree structure
 * Maps to GitHub API tree object format
 */
export type TreeNode = {
	path: string,
	mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined,
	type: "commit" | "blob" | "tree" | undefined,
	sha: string | null};

type OctokitCallMethods = {
	getUser: () => Promise<{owner: string, avatarUrl: string}>
	getRepos: () => Promise<string[]>
	getRef: (ref: string) => Promise<string>
	checkRepoExists: () => Promise<boolean>
	getTree: (tree_sha: string) => Promise<TreeNode[]>
	getCommitTreeSha: (ref: string) => Promise<string>
	getRemoteTreeSha: (tree_or_ref_sha: string) => Promise<{[k:string]: string}>
	createBlob: (content: string, encoding: string) =>Promise<string>
	createTreeNodeFromFile: ({path, status, extension}: LocalChange, remoteTree: TreeNode[]) => Promise<TreeNode|null>
	createCommit: (treeSha: string, parentSha: string) =>Promise<string>
	updateRef: (sha: string, ref: string) => Promise<string>
	getBlob: (file_sha:string) =>Promise<string>
};

/**
 * Interface for the Fit data access layer.
 *
 * Provides access to both local vault state (via LocalVault) and remote GitHub
 * repository state (via Octokit). This is the primary interface used by FitSync,
 * FitPull, and FitPush to access storage backends.
 *
 * Key characteristics:
 * - **Not the sync orchestrator** - that's FitSync's role
 * - **Data access only** - provides primitives for reading/writing both local and remote
 * - **State management** - maintains cached SHAs for efficient change detection
 *
 * @see Fit - The concrete implementation
 * @see FitSync - The orchestrator that uses this interface
 */
export interface IFit extends OctokitCallMethods{
	owner: string
	repo: string
	branch: string
	headers: {[k: string]: string}
	deviceName: string
	localSha: Record<string, string>              // Cache of local file SHAs
	lastFetchedCommitSha: string | null           // Last synced commit SHA
	lastFetchedRemoteSha: Record<string, string>  // Cache of remote file SHAs
	octokit: Octokit
	vaultOps: VaultOperations
	fileSha1: (path: string) => Promise<string>
}

/**
 * HTTP error from GitHub API operations.
 *
 * Thrown by all GitHub API methods in Fit when Octokit requests fail.
 * Contains the HTTP status code (or null for network errors) and the source
 * method name for debugging.
 *
 * @property status - HTTP status code, or null if network error (couldn't reach GitHub)
 * @property source - Name of the GitHub API method that failed
 *
 * @see FitSync.sync() - Catches and categorizes these errors for user-friendly messages
 */
export class OctokitHttpError extends Error {
	status: number | null;
	source: keyof OctokitCallMethods;

	constructor(message: string, status: number | null, source: keyof OctokitCallMethods) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.source = source;
	}
}

/**
 * Data access layer for local vault and remote GitHub repository.
 *
 * Provides low-level primitives for:
 * - **Local storage**: Reading/writing vault files via LocalVault
 * - **Remote storage**: GitHub API operations via Octokit
 * - **State management**: Cached SHAs for efficient change detection
 * - **Change detection**: Helpers for comparing local vs remote state
 *
 * Architecture:
 * - **Used by**: FitSync (orchestrator), FitPull, FitPush
 * - **Uses**: LocalVault (for Obsidian vault), Octokit (for GitHub API)
 * - **Role**: Data access layer - NOT the sync orchestrator (that's FitSync)
 *
 * Key cached state:
 * - `localSha`: Last known local file SHAs (updated after successful sync)
 * - `lastFetchedRemoteSha`: Last known remote file SHAs (from GitHub tree)
 * - `lastFetchedCommitSha`: Last synced commit SHA (for detecting remote updates)
 *
 * @see FitSync - The high-level orchestrator that coordinates sync operations
 * @see LocalVault - Abstracts Obsidian vault file operations
 */
export class Fit implements IFit {
	owner: string;
	repo: string;
	auth: string | undefined;
	branch: string;
	headers: {[k: string]: string};
	deviceName: string;
	localSha: Record<string, string>;
	lastFetchedCommitSha: string | null;
	lastFetchedRemoteSha: Record<string, string>;
	octokit: Octokit;
	vaultOps: VaultOperations;
	private _repoExistsCache: boolean | null = null; // Cache invalidated when owner/repo change in loadSettings()


	constructor(setting: FitSettings, localStores: LocalStores, vaultOps: VaultOperations) {
		this.loadSettings(setting);
		this.loadLocalStore(localStores);
		this.vaultOps = vaultOps;
		this.headers = {
			// Hack to disable caching which leads to inconsistency for
			// read after write https://github.com/octokit/octokit.js/issues/890
			"If-None-Match": '',
			'X-GitHub-Api-Version': '2022-11-28'
		};
	}

	loadSettings(setting: FitSettings) {
		this.owner = setting.owner;
		this.repo = setting.repo;
		this.branch = setting.branch;
		this.deviceName = setting.deviceName;

		// Use Octokit with retry plugin for enhanced rate limiting handling
		const OctokitWithRetry = Octokit.plugin(retry);
		this.octokit = new OctokitWithRetry({
			auth: setting.pat
			// Retry plugin operates silently - users will simply experience fewer rate limit errors
			// Future: Could add verbose logging option to plugin settings
		});
		this._repoExistsCache = null; // Invalidate cache when owner/repo potentially change
	}

	loadLocalStore(localStore: LocalStores) {
		this.localSha = localStore.localSha;
		this.lastFetchedCommitSha = localStore.lastFetchedCommitSha;
		this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha;
	}

	async fileSha1(fileContent: string): Promise<string> {
		const enc = new TextEncoder();
		const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(fileContent));
		const hashArray = Array.from(new Uint8Array(hashBuf));
		const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		return hashHex;
	}

	async computeFileLocalSha(path: string): Promise<string> {
		// Note: only support TFile now, investigate need for supporting TFolder later on
		const file = await this.vaultOps.getTFile(path);
		// compute sha1 based on path and file content
		let content: string;
		if (RECOGNIZED_BINARY_EXT.includes(file.extension)) {
			content = arrayBufferToBase64(await this.vaultOps.vault.readBinary(file));
		} else {
			content = await this.vaultOps.vault.read(file);
		}
		return await this.fileSha1(path + content);
	}

	async computeLocalSha(): Promise<{[k:string]:string}> {
		const paths = this.vaultOps.vault.getFiles().map(f=>{
			// ignore local files in the _fit/ directory
			return f.path.startsWith("_fit/") ? null : f.path;
		}).filter(Boolean);
		return Object.fromEntries(
			await Promise.all(
				paths.map(async (p: string): Promise<[string, string]> =>{
					return [p, await this.computeFileLocalSha(p)];
				})
			)
		);
	}

	async remoteUpdated(): Promise<{remoteCommitSha: string, updated: boolean}> {
		const remoteCommitSha = await this.getLatestRemoteCommitSha();
		return {remoteCommitSha, updated: remoteCommitSha !== this.lastFetchedCommitSha};
	}

	async getLocalChanges(currentLocalSha?: Record<string, string>): Promise<LocalChange[]> {
		if (!currentLocalSha) {
			currentLocalSha = await this.computeLocalSha();
		}
		const localChanges = compareSha(currentLocalSha, this.localSha, "local");
		return localChanges;
	}

	async getRemoteChanges(remoteTreeSha: {[k: string]: string}): Promise<RemoteChange[]> {
		const remoteChanges = compareSha(remoteTreeSha, this.lastFetchedRemoteSha, "remote");
		return remoteChanges;
	}

	getClashedChanges(localChanges: LocalChange[], remoteChanges:RemoteChange[]): Array<{path: string, localStatus: LocalFileStatus, remoteStatus: RemoteChangeType}> {
		const localChangePaths = localChanges.map(c=>c.path);
		const remoteChangePaths = remoteChanges.map(c=>c.path);
		const clashedFiles = localChangePaths.map(
			(path, localIndex) => {
				const remoteIndex = remoteChangePaths.indexOf(path);
				if (remoteIndex !== -1) {
					return {path, localIndex, remoteIndex};
				}
				return null;
			}).filter(Boolean) as Array<{path: string, localIndex: number, remoteIndex:number}>;
		return clashedFiles.map(
			({path, localIndex, remoteIndex}) => {
				return {
					path,
					localStatus: localChanges[localIndex].status,
					remoteStatus: remoteChanges[remoteIndex].status
				};
			});
	}

	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		try {
			const {data: response} = await this.octokit.request(
				`GET /user`, {
					headers: this.headers
				});
			return {owner: response.login, avatarUrl:response.avatar_url};
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "getUser");
		}
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
			throw new OctokitHttpError(error.message, error.status ?? null, "getRepos");
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
				});
			return response.map(r => r.name);
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "getRepos");
		}
	}

	/**
     * Check if repository exists and is accessible - returns boolean for 404, throws for other errors
     * Cached to avoid repeated API calls during error handling
     */
	async checkRepoExists(): Promise<boolean> {
		if (this._repoExistsCache !== null) {
			return this._repoExistsCache; // Return cached result (true or false)
		}

		try {
			await this.octokit.request(`GET /repos/{owner}/{repo}`, {
				owner: this.owner,
				repo: this.repo,
				headers: this.headers
			});
			this._repoExistsCache = true;
			return true;
		} catch (error) {
			if (error.status === 404) {
				this._repoExistsCache = false;
				return false;
			}
			// Throw for non-404 errors (auth, network, etc.)
			throw new OctokitHttpError(error.message, error.status ?? null, "checkRepoExists");
		}
	}

	async getRef(ref: string): Promise<string> {
		try {
			const {data: response} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/ref/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref: ref,
					headers: this.headers
				});
			return response.object.sha;
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status ?? null, "getRef");
		}
	}

	// Get the sha of the latest commit in the default branch (set by user in setting)
	async getLatestRemoteCommitSha(ref = `heads/${this.branch}`): Promise<string> {
		return await this.getRef(ref);
	}

	// ref Can be a commit SHA, branch name (heads/BRANCH_NAME), or tag name (tags/TAG_NAME),
	// refers to https://git-scm.com/book/en/v2/Git-Internals-Git-References
	/**
	 * Get full commit data from GitHub API
	 * @param ref - commit SHA or ref name (e.g., "heads/main")
	 * @returns Full commit response from GitHub
	 * @private
	 */
	private async getCommit(ref: string) {
		const {data: commit} =  await this.octokit.request(
			`GET /repos/{owner}/{repo}/commits/{ref}`, {
				owner: this.owner,
				repo: this.repo,
				ref,
				headers: this.headers
			});
		return commit;
	}

	/**
	 * Get just the tree SHA from a commit
	 */
	async getCommitTreeSha(ref: string): Promise<string> {
		const commit = await this.getCommit(ref);
		return commit.commit.tree.sha;
	}

	async getTree(tree_sha: string): Promise<TreeNode[]> {
		const { data: tree } =  await this.octokit.request(
			`GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
				owner: this.owner,
				repo: this.repo,
				tree_sha,
				recursive: 'true',
				headers: this.headers
			});
		return tree.tree as TreeNode[];
	}

	// get the remote tree sha in the format compatible with local store
	async getRemoteTreeSha(tree_or_ref_sha: string): Promise<{[k:string]: string}> {
		// Try to get commit info first (works if input is ref/commit SHA)
		// This lets us check for empty tree before calling getTree (avoiding 404)
		let treeSha;
		try {
			treeSha = await this.getCommitTreeSha(tree_or_ref_sha);
		} catch (_error) {
			// If getCommit fails, fall back to trying input as tree SHA directly.
			// Any error will surface when we try getTree() below.
			treeSha = tree_or_ref_sha;
		}

		// Check if this is the empty tree - if so, skip getTree() call (would return 404)
		const remoteTree: TreeNode[] = treeSha === EMPTY_TREE_SHA
			? []
			: await this.getTree(treeSha);

		const remoteSha = Object.fromEntries(remoteTree.map((node: TreeNode) : [string, string] | null=>{
			// currently ignoring directory changes, if you'd like to upload a new directory,
			// a quick hack would be creating an empty file inside
			if (node.type=="blob") {
				if (!node.path || !node.sha) {
					throw new Error("Path or sha not found for blob node in remote");
				}
				// ignore changes in the _fit/ directory
				if (node.path.startsWith("_fit/")) {return null;}
				return [node.path, node.sha];
			}
			return null;
		}).filter(Boolean) as [string, string][]);
		return remoteSha;
	}

	async createBlob(content: string, encoding: string): Promise<string> {
		const {data: blob} = await this.octokit.request(
			`POST /repos/{owner}/{repo}/git/blobs`, {
				owner: this.owner,
				repo: this.repo,
				content,
				encoding,
				headers: this.headers
			});
		return blob.sha;
	}


	async createTreeNodeFromFile({path, status, extension}: LocalChange, remoteTree: Array<TreeNode>): Promise<TreeNode|null> {
		if (status === "deleted") {
			// skip creating deletion node if file not found on remote
			if (remoteTree.every(node => node.path !== path)) {
				return null;
			}
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null
			};
		}
		const file = await this.vaultOps.getTFile(path);
		let encoding: string;
		let content: string;
		// TODO check whether every files including md can be read using readBinary to reduce code complexity
		if (extension && RECOGNIZED_BINARY_EXT.includes(extension)) {
			encoding = "base64";

			const fileArrayBuf = await this.vaultOps.vault.readBinary(file);
			const uint8Array = new Uint8Array(fileArrayBuf);
			let binaryString = '';
			for (let i = 0; i < uint8Array.length; i++) {
				binaryString += String.fromCharCode(uint8Array[i]);
			}
			content = btoa(binaryString);
		} else {
			encoding = 'utf-8';
			content = await this.vaultOps.vault.read(file);
		}
		const blobSha = await this.createBlob(content, encoding);
		// skip creating node if file found on remote is the same as the created blob
		if (remoteTree.some(node => node.path === path && node.sha === blobSha)) {
			return null;
		}
		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blobSha,
		};
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
		);
		return newTree.sha;
	}

	async createCommit(treeSha: string, parentSha: string): Promise<string> {
		const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`;
		const { data: createdCommit } = await this.octokit.request(
			`POST /repos/{owner}/{repo}/git/commits` , {
				owner: this.owner,
				repo: this.repo,
				message,
				tree: treeSha,
				parents: [parentSha],
				headers: this.headers
			});
		return createdCommit.sha;
	}

	async updateRef(sha: string, ref = `heads/${this.branch}`): Promise<string> {
		const { data:updatedRef } = await this.octokit.request(
			`PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
				owner: this.owner,
				repo: this.repo,
				ref,
				sha,
				headers: this.headers
			});
		return updatedRef.object.sha;
	}

	async getBlob(file_sha:string): Promise<string> {
		const { data: blob } = await this.octokit.request(
			`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
				owner: this.owner,
				repo: this.repo,
				file_sha,
				headers: this.headers
			});
		return blob.content;
	}


	/**
     * Generate user-friendly error message from structured sync error
     */
	getSyncErrorMessage(syncError: SyncError): string {
		// Return user-friendly message based on error type
		switch (syncError.type) {
			case 'network':
				return `${syncError.detailMessage}. Please check your internet connection.`;

			case 'remote_access':
				return `${syncError.detailMessage}. Check your GitHub personal access token.`;

			case 'remote_not_found':
				return `${syncError.detailMessage}. Check your repo and branch settings.`;

			case 'filesystem': {
				return `File system error: ${syncError.detailMessage}`;
			}

			case 'unknown':
			case 'api_error':
			default:
				return syncError.detailMessage;
		}
	}

}
