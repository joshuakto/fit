/**
 * GitHub Remote Vault
 *
 * Implements IVault for GitHub repository trees.
 * Encapsulates all GitHub API operations for file state management.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { IVault, FileState, RemoteNotFoundError } from "./vault";
import { FileOpRecord } from "./fitTypes";
import { EMPTY_TREE_SHA, RECOGNIZED_BINARY_EXT } from "./utils";

/**
 * Represents a node in GitHub's git tree structure
 * Maps to GitHub API tree object format
 */
export type TreeNode = {
	path: string,
	mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined,
	type: "commit" | "blob" | "tree" | undefined,
	sha: string | null
};

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

	// ===== Read Operations =====

	/**
	 * Get reference SHA for the current branch.
	 * Throws RemoteNotFoundError on 404 (repository or branch not found).
	 */
	private async getRef(ref: string = `heads/${this.branch}`): Promise<string> {
		try {
			const {data: response} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/ref/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref: ref,
					headers: this.headers
				});
			return response.object.sha;
		} catch (error: unknown) {
			// Convert 404 errors to RemoteNotFoundError for cleaner error handling upstream
			if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
				// Branch ref not found - could be missing branch or missing repo
				// Try to distinguish for better error messages
				let detailMessage;
				try {
					detailMessage = await this.checkRepoExists() ?
						`Branch '${this.branch}' not found on repository '${this.owner}/${this.repo}'`
						: `Repository '${this.owner}/${this.repo}' not found`;
				} catch (_repoError) {
					// For checkRepoExists errors (403, network, etc.), fall back to generic message
					detailMessage = `Repository '${this.owner}/${this.repo}' or branch '${this.branch}' not found`;
				}
				throw new RemoteNotFoundError(
					detailMessage,
					this.owner,
					this.repo,
					this.branch
				);
			}
			throw error;
		}
	}

	/**
	 * Get the latest commit SHA from the current branch
	 * TODO: Make private after Fit.remoteUpdated stops using this
	 */
	async getLatestCommitSha(): Promise<string> {
		return await this.getRef(`heads/${this.branch}`);
	}

	/**
	 * Get full commit data from GitHub API
	 */
	private async getCommit(ref: string) {
		const {data: commit} = await this.octokit.request(
			`GET /repos/{owner}/{repo}/commits/{ref}`, {
				owner: this.owner,
				repo: this.repo,
				ref,
				headers: this.headers
			});
		return commit;
	}

	/**
	 * Get tree SHA from a commit
	 */
	private async getCommitTreeSha(ref: string): Promise<string> {
		const commit = await this.getCommit(ref);
		return commit.commit.tree.sha;
	}

	/**
	 * Get the git tree for a given tree SHA
	 */
	private async getTree(tree_sha: string): Promise<TreeNode[]> {
		const { data: tree } = await this.octokit.request(
			`GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
				owner: this.owner,
				repo: this.repo,
				tree_sha,
				recursive: 'true',
				headers: this.headers
			});
		return tree.tree as TreeNode[];
	}


	/**
	 * Read file content for a specific SHA from GitHub blobs
	 */
	async readFileContent(fileSha: string): Promise<string> {
		const { data: blob } = await this.octokit.request(
			`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
				owner: this.owner,
				repo: this.repo,
				file_sha: fileSha,
				headers: this.headers
			});
		return blob.content;
	}

	// ===== Write Operations =====

	/**
	 * Create a blob on GitHub from content
	 */
	private async createBlob(content: string, encoding: string): Promise<string> {
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

	/**
	 * Create a tree node for a file change.
	 * Creates blob from content and returns tree node, or null if no change needed.
	 *
	 * @param path - File path
	 * @param content - File content (base64 for binary, raw text otherwise) or null for deletion
	 * @param encoding - "base64" or "utf-8" (if not provided, determined from file extension)
	 * @param remoteTree - Current remote tree nodes (for optimization - skip if unchanged)
	 * @returns TreeNode to include in commit, or null if no change needed
	 */
	async createTreeNodeFromContent(
		path: string,
		content: string | null,
		remoteTree: TreeNode[],
		encoding?: "base64" | "utf-8"
	): Promise<TreeNode | null> {
		// Deletion case (content is null)
		if (content === null) {
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
			encoding = RECOGNIZED_BINARY_EXT.includes(extension) ? "base64" : "utf-8";
		}
		const blobSha = await this.createBlob(content, encoding);

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
		base_tree_sha: string
	): Promise<string> {
		const {data: newTree} = await this.octokit.request(
			`POST /repos/{owner}/{repo}/git/trees`, {
				owner: this.owner,
				repo: this.repo,
				tree: treeNodes,
				base_tree: base_tree_sha,
				headers: this.headers
			}
		);
		return newTree.sha;
	}

	/**
	 * Create a commit pointing to a tree
	 */
	private async createCommit(treeSha: string, parentSha: string): Promise<string> {
		const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`;
		const { data: createdCommit } = await this.octokit.request(
			`POST /repos/{owner}/{repo}/git/commits`, {
				owner: this.owner,
				repo: this.repo,
				message,
				tree: treeSha,
				parents: [parentSha],
				headers: this.headers
			});
		return createdCommit.sha;
	}

	/**
	 * Update branch reference to point to new commit
	 */
	private async updateRef(sha: string, ref: string = `heads/${this.branch}`): Promise<string> {
		const { data: updatedRef } = await this.octokit.request(
			`PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
				owner: this.owner,
				repo: this.repo,
				ref,
				sha,
				headers: this.headers
			});
		return updatedRef.object.sha;
	}

	/**
	 * Get remote tree as SHA map (path -> blob SHA), with optional filtering.
	 * Accepts either tree SHA or ref/commit SHA.
	 *
	 * @param tree_or_ref_sha - Tree SHA or ref/commit SHA (e.g., "heads/main", commit SHA, or tree SHA)
	 * @param shouldIncludePath - Optional filter function (path => boolean). If not provided, includes all paths.
	 * @returns Map of path -> blob SHA for files matching the filter
	 */
	async getRemoteTreeSha(
		tree_or_ref_sha: string,
		shouldIncludePath?: (path: string) => boolean
	): Promise<{[k:string]: string}> {
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
			// Currently ignoring directory changes, if you'd like to upload a new directory,
			// a quick hack would be creating an empty file inside
			if (node.type=="blob") {
				if (!node.path || !node.sha) {
					throw new Error("Path or sha not found for blob node in remote");
				}
				// Apply filter if provided
				if (shouldIncludePath && !shouldIncludePath(node.path)) {
					return null;
				}
				return [node.path, node.sha];
			}
			return null;
		}).filter(Boolean) as [string, string][]);
		return remoteSha;
	}

	// ===== GitHub Utility Operations (not part of IVault) =====

	/**
	 * Get authenticated user information
	 */
	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		const {data: response} = await this.octokit.request(
			`GET /user`, {
				headers: this.headers
			});
		return {owner: response.login, avatarUrl: response.avatar_url};
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

			page++;
		}

		return allRepos;
	}

	/**
	 * Get list of branches for the repository.
	 * Throws RemoteNotFoundError on 404 (repository not found).
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
			if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
				throw new RemoteNotFoundError(
					`Repository '${this.owner}/${this.repo}' not found`,
					this.owner,
					this.repo
				);
			}
			throw error;
		}
	}

	/**
	 * Check if repository exists and is accessible
	 * Result is cached to avoid repeated API calls during error handling.
	 * @returns true if repository exists, false if 404 (not found)
	 * @throws OctokitHttpError for non-404 errors (auth, network, etc.)
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
			if (error.status === 404) {
				this.repoExistsCache = false;
				return false;
			}
			// Re-throw non-404 errors (don't cache)
			throw error;
		}
	}

	// ===== IVault Implementation =====

	/**
	 * Apply a batch of changes to remote (creates commit and pushes)
	 * This is the primary write operation - creates a single commit with all changes
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: string}>,
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
	 * Note: Sync policy filtering (e.g., excluding _fit/) is handled
	 * by the caller (Fit), not by the vault.
	 */
	shouldTrackState(path: string): boolean {
		return true;
	}

	/**
	 * Fetch tree from GitHub at the latest commit and return it.
	 * Implements IVault.readFromSource().
	 *
	 * For optimized usage when you already have the commit SHA, use readFromSourceAtCommit() instead.
	 */
	async readFromSource(): Promise<FileState> {
		const commitSha = await this.getLatestCommitSha();
		return await this.readFromSourceAtCommit(commitSha);
	}

	/**
	 * Fetch tree from GitHub at a specific commit and return it.
	 * Use this when you already have a commit SHA to avoid duplicate getLatestCommitSha() calls.
	 *
	 * @param commitSha - Commit SHA to read from
	 * TODO: Better solution - move state caching into vault. Initialize vault with lastFetchedRemoteSha,
	 *       then vault maintains latestKnownState cache. readFromSource() checks if commit changed - if
	 *       not, return cached state (skip tree/blob fetches). See CLAUDE.md Medium Priority section.
	 */
	async readFromSourceAtCommit(commitSha: string): Promise<FileState> {
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

		return { ...newState };
	}
}
