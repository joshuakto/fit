/**
 * GitHub Remote Vault
 *
 * Implements IVault for GitHub repository trees.
 * Encapsulates all GitHub API operations for file state management.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { IVault, FileState, VaultError, VaultReadResult } from "./vault";
import { FileOpRecord } from "./fitTypes";
import { BlobSha, CommitSha, EMPTY_TREE_SHA, TreeSha } from "./util/hashing";
import { FileContent, isBinaryExtension } from "./util/contentEncoding";

/**
 * Represents a node in GitHub's git tree structure
 * Maps to GitHub API tree object format
 */
export type TreeNode = {
	path: string,
	mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined
} & (
	| { type: "commit", sha: CommitSha | null }
	| { type: "blob", sha: BlobSha | null }
	| { type: "tree", sha: TreeSha | null }
	| { type: undefined, sha: null }
);

/**
 * Remote vault implementation for GitHub repositories.
 *
 * Encapsulates GitHub-specific operations:
 * - Fetching repository tree state via Octokit
 * - Computing file SHAs from GitHub blobs
 * - Remote change detection
 * - Push/commit operations for applying changes
 *
 * Architecture:
 * - Read operations: Fetch tree state from GitHub API
 * - Write operations: Create blobs/trees/commits and update refs
 * - No filtering logic: Caller (Fit) is responsible for filtering paths before calling vault methods
 *
 * Future: Create RemoteGitLabVault, RemoteGiteaVault as additional implementations.
 */
export class RemoteGitHubVault implements IVault {
	private octokit: Octokit;
	private owner: string;
	private repo: string;
	private branch: string;
	private headers: {[k: string]: string};
	private deviceName: string;
	private repoExistsCache: boolean | null = null;

	// Internal cache for remote state optimization
	// Avoids redundant API calls when remote hasn't changed
	private latestKnownCommitSha: CommitSha | null = null;
	private latestKnownState: FileState | null = null;

	constructor(
		pat: string,
		owner: string,
		repo: string,
		branch: string,
		deviceName: string
	) {
		// Use Octokit with retry plugin for enhanced rate limiting handling
		const OctokitWithRetry = Octokit.plugin(retry);
		this.octokit = new OctokitWithRetry({
			auth: pat
			// Retry plugin operates silently - users will simply experience fewer rate limit errors
			// Future: Could add verbose logging option to plugin settings
		});

		this.owner = owner;
		this.repo = repo;
		this.branch = branch;
		this.deviceName = deviceName;

		// Headers to disable GitHub API caching (prevents read-after-write inconsistency)
		// See: https://github.com/octokit/octokit.js/issues/890
		this.headers = {
			"If-None-Match": '',
			'X-GitHub-Api-Version': '2022-11-28'
		};
	}

	// ===== Accessors =====

	getOwner(): string {
		return this.owner;
	}

	getRepo(): string {
		return this.repo;
	}

	getBranch(): string {
		return this.branch;
	}

	// ===== Error Handling =====

	/**
	 * Wrap octokit errors and convert to VaultError for consistent error handling.
	 *
	 * @param error - The error from octokit
	 * @param notFoundStrategy - How to handle 404 errors:
	 *   - 'repo': 404 means repository doesn't exist
	 *   - 'repo-or-branch': 404 could be repo or branch (calls checkRepoExists to distinguish)
	 *   - 'ignore': Don't treat 404 specially, re-throw as generic error
	 */
	private async wrapOctokitError(
		error: unknown,
		notFoundStrategy: 'repo' | 'repo-or-branch' | 'ignore'
	): Promise<never> {
		const errorObj = error as { status?: number | null; response?: unknown; message?: string };

		// No status or no response indicates network/connectivity issue
		if (errorObj.status === null || errorObj.status === undefined || !errorObj.response) {
			throw VaultError.network(
				errorObj.message || "Couldn't reach GitHub API",
				{ originalError: error }
			);
		}

		// 404: Resource not found - handle based on strategy
		if (errorObj.status === 404 && notFoundStrategy !== 'ignore') {
			let detailMessage: string;

			if (notFoundStrategy === 'repo') {
				detailMessage = `Repository '${this.owner}/${this.repo}' not found`;
			} else {
				// repo-or-branch: Try to distinguish
				try {
					detailMessage = await this.checkRepoExists()
						? `Branch '${this.branch}' not found on repository '${this.owner}/${this.repo}'`
						: `Repository '${this.owner}/${this.repo}' not found`;
				} catch (_repoError) {
					// checkRepoExists failed (403, network, etc.) - use generic message
					detailMessage = `Repository '${this.owner}/${this.repo}' or branch '${this.branch}' not found`;
				}
			}

			throw VaultError.remoteNotFound(detailMessage, { originalError: error });
		}

		// 401/403: Authentication/authorization failures
		if (errorObj.status === 401 || errorObj.status === 403) {
			throw VaultError.authentication(
				errorObj.message || 'Authentication failed',
				{ originalError: error }
			);
		}

		// Other errors: re-throw as-is
		throw error;
	}

	// ===== Read Operations =====

	/**
	 * Get reference SHA for the current branch.
	 * Throws VaultError (remote_not_found) on 404 (repository or branch not found).
	 */
	private async getRef(ref: string = `heads/${this.branch}`): Promise<CommitSha> {
		try {
			const {data: response} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/ref/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref: ref,
					headers: this.headers
				});
			return response.object.sha as CommitSha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	/**
	 * Get the latest commit SHA from the current branch
	 */
	private async getLatestCommitSha(): Promise<CommitSha> {
		return await this.getRef(`heads/${this.branch}`);
	}

	/**
	 * Get full commit data from GitHub API
	 */
	private async getCommit(ref: string) {
		try {
			const {data: commit} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/commits/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref,
					headers: this.headers
				});
			return commit;
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	/**
	 * Get tree SHA from a commit
	 */
	private async getCommitTreeSha(ref: CommitSha): Promise<TreeSha> {
		const commit = await this.getCommit(ref);
		return commit.commit.tree.sha as TreeSha;
	}

	/**
	 * Get the git tree for a given tree SHA
	 */
	private async getTree(tree_sha: TreeSha): Promise<TreeNode[]> {
		try {
			const { data: tree } = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
					owner: this.owner,
					repo: this.repo,
					tree_sha,
					recursive: 'true',
					headers: this.headers
				});
			return tree.tree as TreeNode[];
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}


	/**
	 * Read file content from GitHub by path.
	 *
	 * Note: Returns file content as of the last readFromSource() call. Does NOT force a
	 * fresh remote fetch. Caller should call readFromSource() first if they need the
	 * latest remote state.
	 *
	 * @param path - File path to read
	 * @throws Error if remote state not yet fetched or file not found in remote state
	 */
	async readFileContent(path: string): Promise<FileContent> {
		// Look up blob SHA from cached state
		if (this.latestKnownState === null) {
			throw new Error(
				`Remote repository state not yet loaded. Cannot read file '${path}'. ` +
				`Sync operation should call readFromSource() first.`
			);
		}

		const blobSha = this.latestKnownState[path];
		if (!blobSha) {
			throw new Error(
				`File '${path}' does not exist in remote repository ` +
				`(commit ${this.latestKnownCommitSha || 'unknown'} on ${this.owner}/${this.repo}).`
			);
		}

		// Fetch blob content from GitHub
		// GitHub API ALWAYS returns content as base64, regardless of file type
		try {
			const { data: blob } = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
					owner: this.owner,
					repo: this.repo,
					file_sha: blobSha,
					headers: this.headers
				});
			return FileContent.fromBase64(blob.content);
		} catch (error) {
			// Blob not found (404) is a data error, not a vault-level error
			// Network/auth errors still converted to VaultError
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	// ===== Write Operations =====

	/**
	 * Create a blob on GitHub from content
	 */
	private async createBlob(content: string, encoding: string): Promise<BlobSha> {
		try {
			const {data: blob} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/blobs`, {
					owner: this.owner,
					repo: this.repo,
					content,
					encoding,
					headers: this.headers
				});
			return blob.sha as BlobSha;
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Create a tree node for a file change.
	 * Creates blob from content and returns tree node, or null if no change needed.
	 *
	 * @param path - File path
	 * @param content - File content (base64 for binary, raw text otherwise) or null for deletion
	 * @param remoteTree - Current remote tree nodes (for optimization - skip if unchanged)
	 * @returns TreeNode to include in commit, or null if no change needed
	 */
	private async createTreeNodeFromContent(
		path: string,
		content: FileContent | null,
		remoteTree: TreeNode[]
	): Promise<TreeNode | null> {
		let rawContent: string | null = null;
		let encoding: 'base64' | 'utf-8' | undefined;
		if (content !== null) {
			const rawContentObj = content.toRaw();
			rawContent = rawContentObj.content;
			encoding = rawContentObj.encoding === 'base64' ? 'base64' : 'utf-8';
		}

		// Deletion case (content is null)
		if (rawContent === null) {
			// Skip deletion if file doesn't exist on remote
			if (remoteTree.every(node => node.path !== path)) {
				return null;
			}
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null  // null SHA indicates deletion
			};
		}

		// Addition/modification case
		if (!encoding) {
			const extension = path.split('.').pop() || '';
			encoding = isBinaryExtension(extension) ? "base64" : "utf-8";
		}
		const blobSha = await this.createBlob(rawContent, encoding);

		// Skip if file on remote is identical
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

	/**
	 * Create a new tree from tree nodes
	 */
	private async createTree(
		treeNodes: TreeNode[],
		base_tree_sha: TreeSha
	): Promise<TreeSha> {
		try {
			const {data: newTree} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/trees`, {
					owner: this.owner,
					repo: this.repo,
					tree: treeNodes,
					base_tree: base_tree_sha,
					headers: this.headers
				}
			);
			return newTree.sha as TreeSha;
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Create a commit pointing to a tree
	 */
	private async createCommit(treeSha: TreeSha, parentSha: CommitSha): Promise<CommitSha> {
		const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`;
		try {
			const { data: createdCommit } = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/commits`, {
					owner: this.owner,
					repo: this.repo,
					message,
					tree: treeSha,
					parents: [parentSha],
					headers: this.headers
				});
			return createdCommit.sha as CommitSha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Update branch reference to point to new commit
	 */
	private async updateRef(sha: string, ref: string = `heads/${this.branch}`): Promise<string> {
		try {
			const { data: updatedRef } = await this.octokit.request(
				`PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref,
					sha,
					headers: this.headers
				});
			return updatedRef.object.sha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	// ===== GitHub Utility Operations (not part of IVault) =====

	/**
	 * Get authenticated user information
	 */
	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		try {
			const {data: response} = await this.octokit.request(
				`GET /user`, {
					headers: this.headers
				});
			return {owner: response.login, avatarUrl: response.avatar_url};
		} catch (error) {
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	/**
	 * Get list of repositories owned by authenticated user
	 */
	async getRepos(): Promise<string[]> {
		const allRepos: string[] = [];
		let page = 1;
		const perPage = 100; // Set to the maximum value of 100

		let hasMorePages = true;
		while (hasMorePages) {
			try {
				const { data: response } = await this.octokit.request(
					`GET /user/repos`, {
						affiliation: "owner",
						headers: this.headers,
						per_page: perPage,
						page: page
					}
				);
				allRepos.push(...response.map(r => r.name));
				// Check if there are more pages
				if (response.length < perPage) {
					hasMorePages = false;
				}
			} catch (error) {
				return await this.wrapOctokitError(error, 'ignore');
			}

			page++;
		}

		return allRepos;
	}

	/**
	 * Get list of branches for the repository.
	 * Throws VaultError (remote_not_found) on 404 (repository not found).
	 */
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
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Check if repository exists and is accessible
	 * Result is cached to avoid repeated API calls during error handling.
	 * @returns true if repository exists, false if 404 (not found)
	 * @throws VaultError for non-404 errors (auth, network, etc.)
	 */
	private async checkRepoExists(): Promise<boolean> {
		if (this.repoExistsCache !== null) {
			return this.repoExistsCache;
		}

		try {
			await this.octokit.request(`GET /repos/{owner}/{repo}`, {
				owner: this.owner,
				repo: this.repo,
				headers: this.headers
			});
			this.repoExistsCache = true;
			return true;
		} catch (error) {
			const errorObj = error as { status?: number };
			if (errorObj.status === 404) {
				this.repoExistsCache = false;
				return false;
			}
			// Non-404 errors: wrap and throw
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	// ===== IVault Implementation =====

	/**
	 * Apply a batch of changes to remote (creates commit and pushes)
	 * This is the primary write operation - creates a single commit with all changes
	 * Accepts PlainTextContent for text files or Base64Content for binary files
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>
	): Promise<FileOpRecord[]> {
		// Get current commit and tree
		const parentCommitSha = await this.getLatestCommitSha();
		const parentTreeSha = await this.getCommitTreeSha(parentCommitSha);
		const remoteTree = parentTreeSha === EMPTY_TREE_SHA
			? []
			: await this.getTree(parentTreeSha);

		// Create tree nodes for all changes
		const treeNodePromises: Promise<TreeNode | null>[] = [];

		// Process file writes/updates
		for (const {path, content} of filesToWrite) {
			treeNodePromises.push(
				this.createTreeNodeFromContent(path, content, remoteTree)
			);
		}

		// Process file deletions
		for (const path of filesToDelete) {
			treeNodePromises.push(
				this.createTreeNodeFromContent(path, null, remoteTree)
			);
		}

		// Wait for all tree nodes and filter out nulls
		const treeNodes = (await Promise.all(treeNodePromises))
			.filter(node => node !== null) as TreeNode[];

		// If no changes needed, return empty array
		if (treeNodes.length === 0) {
			return [];
		}

		// Create tree, commit, and update ref
		const newTreeSha = await this.createTree(treeNodes, parentTreeSha);
		const newCommitSha = await this.createCommit(newTreeSha, parentCommitSha);
		await this.updateRef(newCommitSha);

		// Build file operation records
		const fileOps: FileOpRecord[] = [];

		for (const node of treeNodes) {
			if (!node.path) continue;

			let status: "created" | "changed" | "deleted";
			if (node.sha === null) {
				status = "deleted";
			} else if (remoteTree.some(n => n.path === node.path)) {
				status = "changed";
			} else {
				status = "created";
			}

			fileOps.push({ path: node.path, status });
		}

		return fileOps;
	}

	// ===== Metadata =====

	/**
	 * Check if path should be included in state tracking.
	 *
	 * RemoteGitHubVault can track all paths - no storage limitations.
	 * Always returns true since GitHub can store any file.
	 *
	 * Note: Sync policy filtering (e.g., excluding _fit/, .obsidian/) is handled
	 * by the caller (Fit), not by the vault.
	 */
	shouldTrackState(path: string): boolean {
		return true;
	}

	/**
	 * Fetch tree from GitHub at the latest commit and return it with commit SHA.
	 * Implements IVault.readFromSource().
	 *
	 * Uses internal caching to avoid redundant API calls when remote hasn't changed.
	 * If the latest commit SHA matches the cached SHA, returns cached state immediately.
	 * Uses internal caching to avoid redundant API calls when remote hasn't changed.
	 * If the latest commit SHA matches the cached SHA, returns cached state immediately.
	 */
	async readFromSource(): Promise<VaultReadResult> {
		const commitSha = await this.getLatestCommitSha();

		// Return cached state if remote hasn't changed
		if (commitSha === this.latestKnownCommitSha && this.latestKnownState !== null) {
			return { state: { ...this.latestKnownState }, commitSha };
		}

		// Fetch fresh state from GitHub
		const treeSha = await this.getCommitTreeSha(commitSha);

		// Check if this is the empty tree - skip getTree() call (would return 404)
		const remoteTree: TreeNode[] = treeSha === EMPTY_TREE_SHA
			? []
			: await this.getTree(treeSha);

		// Build FileState from tree (no filtering - caller handles that)
		const newState: FileState = {};
		for (const node of remoteTree) {
			// Only include blobs (files), skip trees (directories)
			if (node.type === "blob" && node.path && node.sha) {
				newState[node.path] = node.sha;
			}
		}

		// Update cache
		this.latestKnownCommitSha = commitSha;
		this.latestKnownState = newState;

		return { state: { ...newState }, commitSha };
	}

}
