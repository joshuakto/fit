/**
 * GitHub Remote Vault
 *
 * Implements IVault for GitHub repository trees.
 * Encapsulates all GitHub API operations for file state management.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { IVault, FileState } from "./vault";
import { RemoteChange, FileOpRecord } from "./fitTypes";
import { compareSha, EMPTY_TREE_SHA, RECOGNIZED_BINARY_EXT } from "./utils";

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
	private baselineState: FileState;
	private repoExistsCache: boolean | null = null;

	constructor(
		pat: string,
		owner: string,
		repo: string,
		branch: string,
		deviceName: string,
		baselineState: FileState = {}
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
		this.baselineState = baselineState;

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
	 * Get reference SHA for the current branch
	 * TODO: Make private after Fit.getRef stops using this
	 */
	async getRef(ref: string = `heads/${this.branch}`): Promise<string> {
		const {data: response} = await this.octokit.request(
			`GET /repos/{owner}/{repo}/git/ref/{ref}`, {
				owner: this.owner,
				repo: this.repo,
				ref: ref,
				headers: this.headers
			});
		return response.object.sha;
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
	 * TODO: Make private after FitPush stops using this (will use applyChanges instead)
	 */
	async getCommitTreeSha(ref: string): Promise<string> {
		const commit = await this.getCommit(ref);
		return commit.commit.tree.sha;
	}

	/**
	 * Get the git tree for a given tree SHA
	 */
	async getTree(tree_sha: string): Promise<TreeNode[]> {
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
	 * Compute current remote state from GitHub tree.
	 * Fetches the latest commit and builds a FileState map of path→SHA.
	 *
	 * Note: Returns ALL files from remote. Caller is responsible for filtering
	 * based on sync policy (e.g., excluding _fit/, .obsidian/).
	 */
	async computeCurrentState(): Promise<FileState> {
		// Get latest commit SHA
		const commitSha = await this.getLatestCommitSha();

		// Get tree SHA from commit (handles empty tree case)
		let treeSha: string;
		try {
			treeSha = await this.getCommitTreeSha(commitSha);
		} catch (_error) {
			// If commit doesn't exist, treat as empty tree
			treeSha = EMPTY_TREE_SHA;
		}

		// Check if this is the empty tree - skip getTree() call (would return 404)
		const remoteTree: TreeNode[] = treeSha === EMPTY_TREE_SHA
			? []
			: await this.getTree(treeSha);

		// Build FileState from tree (no filtering - caller handles that)
		const state: FileState = {};
		for (const node of remoteTree) {
			// Only include blobs (files), skip trees (directories)
			if (node.type === "blob" && node.path && node.sha) {
				state[node.path] = node.sha;
			}
		}

		return state;
	}

	/**
	 * Detect changes between baseline and current remote state.
	 */
	async getChanges(baselineState: FileState): Promise<RemoteChange[]> {
		const currentState = await this.computeCurrentState();
		const changes = compareSha(currentState, baselineState, "remote");
		return changes;
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
	 * TODO: Make private after Fit.createTreeNodeFromFile is refactored
	 */
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
	 * TODO: Make private after FitPush is refactored to use applyChanges()
	 */
	async createTree(
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
	 * TODO: Make private after FitPush is refactored to use applyChanges()
	 */
	async createCommit(treeSha: string, parentSha: string): Promise<string> {
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
	 * TODO: Make private after FitPush and FitSync are refactored to use applyChanges()
	 */
	async updateRef(sha: string, ref: string = `heads/${this.branch}`): Promise<string> {
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
	 * Get list of branches for the repository
	 */
	async getBranches(): Promise<string[]> {
		const {data: response} = await this.octokit.request(
			`GET /repos/{owner}/{repo}/branches`,
			{
				owner: this.owner,
				repo: this.repo,
				headers: this.headers
			});
		return response.map(r => r.name);
	}

	/**
	 * Check if repository exists and is accessible
	 * Result is cached to avoid repeated API calls during error handling.
	 * @returns true if repository exists, false if 404 (not found)
	 * @throws OctokitHttpError for non-404 errors (auth, network, etc.)
	 */
	async checkRepoExists(): Promise<boolean> {
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
	 * Write or update a single file on remote
	 * Note: This creates a commit for a single file change
	 */
	async writeFile(path: string, content: string): Promise<FileOpRecord> {
		// For single file writes, use applyChanges
		const results = await this.applyChanges([{path, content}], []);
		return results[0];
	}

	/**
	 * Delete a single file from remote
	 * Note: This creates a commit for a single file deletion
	 */
	async deleteFile(path: string): Promise<FileOpRecord> {
		// For single file deletes, use applyChanges
		const results = await this.applyChanges([], [path]);
		return results[0];
	}

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
	 * Note: Sync policy filtering (e.g., excluding _fit/, .obsidian/) is handled
	 * by the caller (Fit), not by the vault.
	 */
	shouldTrackState(path: string): boolean {
		return true;
	}

	/**
	 * Update baseline state after successful sync
	 */
	updateBaselineState(newState: FileState): void {
		this.baselineState = newState;
	}

	/**
	 * Get current baseline state
	 */
	getBaselineState(): FileState {
		return { ...this.baselineState };
	}
}
