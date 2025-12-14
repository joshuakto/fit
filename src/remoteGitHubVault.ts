/**
 * GitHub Remote Vault
 *
 * Implements IVault for GitHub repository trees.
 * Encapsulates all GitHub API operations for file state management.
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { ApplyChangesResult, IVault, VaultError, VaultReadResult } from "./vault";
import { FileChange, FileStates } from "./util/changeTracking";
import { BlobSha, CommitSha, EMPTY_TREE_SHA, TreeSha } from "./util/hashing";
import { FileContent } from "./util/contentEncoding";
import { detectNormalizationIssues } from "./util/filePath";
import { withSlowOperationMonitoring } from "./util/asyncMonitoring";
import { fitLogger } from "./logger";

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
export class RemoteGitHubVault implements IVault<"remote"> {
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
	private latestKnownState: FileStates | null = null;

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
	 * Fetch commit SHA and tree SHA in one API call
	 * More efficient than separate getRef() + getCommit() calls
	 */
	private async getLatestCommitAndTreeSha(): Promise<{ commitSha: CommitSha; treeSha: TreeSha }> {
		try {
			const {data: commit} = await this.octokit.request(
				`GET /repos/{owner}/{repo}/commits/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref: this.branch,
					headers: this.headers
				});
			return {
				commitSha: commit.sha as CommitSha,
				treeSha: commit.commit.tree.sha as TreeSha
			};
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
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
			const {data: blob} = await withSlowOperationMonitoring(
				this.octokit.request(
					`POST /repos/{owner}/{repo}/git/blobs`, {
						owner: this.owner,
						repo: this.repo,
						content,
						encoding,
						headers: this.headers
					}),
				'GitHub blob creation'
			);
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
	 * @param currentState - Current remote FileStates (for optimization - skip if unchanged)
	 * @returns TreeNode to include in commit, or null if no change needed
	 */
	private async createTreeNodeFromContent(
		path: string,
		content: FileContent | null,
		currentState: FileStates
	): Promise<TreeNode | null> {
		// Deletion case (content is null)
		if (content === null) {
			// Skip deletion if file doesn't exist on remote
			if (!(path in currentState)) {
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
		const rawContentObj = content.toRaw();
		const rawContent = rawContentObj.content;
		const encoding = rawContentObj.encoding === 'base64' ? 'base64' : 'utf-8';
		const blobSha = await this.createBlob(rawContent, encoding);

		// Skip if file on remote is identical
		if (currentState[path] === blobSha) {
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
	): Promise<ApplyChangesResult<"remote">> {
		// Get current state using cache when available
		const { state: currentState, commitSha: parentCommitSha, treeSha: parentTreeSha } = await this.readFromSource();

		// Create tree nodes for all changes, tracking metadata for error handling
		const operations: Array<{
			path: string;
			sizeBytes: number | null;
			promise: Promise<TreeNode | null>;
		}> = [];

		// Process file writes/updates
		for (const {path, content} of filesToWrite) {
			operations.push({
				path,
				sizeBytes: content.size(),
				promise: this.createTreeNodeFromContent(path, content, currentState)
			});
		}

		// Process file deletions
		for (const path of filesToDelete) {
			operations.push({
				path,
				sizeBytes: null,  // No size for deletions
				promise: this.createTreeNodeFromContent(path, null, currentState)
			});
		}

		// Wait for all tree nodes, collecting both successes and failures
		const results = await Promise.allSettled(operations.map(op => op.promise));

		// Extract successful nodes and collect per-file errors
		const treeNodes: TreeNode[] = [];
		const perFileErrors: Array<{ path: string; error: unknown }> = [];

		results.forEach((result, index) => {
			const { path, sizeBytes } = operations[index];
			if (result.status === 'fulfilled' && result.value !== null) {
				treeNodes.push(result.value);
			} else if (result.status === 'rejected') {
				let error = result.reason;
				// Enhance 422 errors (input too large) with file size
				if (sizeBytes !== null) {
					const errorObj = error as { status?: number };
					if (errorObj.status === 422) {
						const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
						const enhancedError = error instanceof Error ? error : new Error(String(error));
						enhancedError.message = `${enhancedError.message} (file size: ${sizeMB} MB)`;
						error = enhancedError;
					}
				}
				perFileErrors.push({ path, error });
			}
		});

		// If any files failed, throw VaultError with per-file details
		if (perFileErrors.length > 0) {
			const failedPaths = perFileErrors.map(e => e.path);
			throw VaultError.network(
				`Failed to process ${perFileErrors.length} file(s) for remote upload`,
				{ errors: perFileErrors, failedPaths }
			);
		}

		// If no changes needed, return empty result (currentState already from cache)
		if (treeNodes.length === 0) {
			return {
				changes: [],
				commitSha: parentCommitSha,
				treeSha: parentTreeSha,
				newState: currentState
			};
		}

		// Create tree, commit, and update ref
		const newTreeSha = await this.createTree(treeNodes, parentTreeSha);
		const newCommitSha = await this.createCommit(newTreeSha, parentCommitSha);
		await this.updateRef(newCommitSha);

		// Build file operation records and construct new state from known changes
		const changes: FileChange[] = [];
		const newState: FileStates = { ...currentState };

		for (const node of treeNodes) {
			if (!node.path) continue;

			// All nodes should be blobs (type:"blob") from createTreeNodeFromContent
			// which only creates blob nodes for files
			let changeType: "ADDED" | "MODIFIED" | "REMOVED";
			if (node.sha === null) {
				// Deletion
				changeType = "REMOVED";
				delete newState[node.path];
			} else if (node.path in currentState) {
				// Modification - node.sha is BlobSha for blob nodes
				changeType = "MODIFIED";
				newState[node.path] = node.sha as BlobSha;
			} else {
				// Addition - node.sha is BlobSha for blob nodes
				changeType = "ADDED";
				newState[node.path] = node.sha as BlobSha;
			}

			changes.push({ path: node.path, type: changeType });
		}

		// Update cache to avoid redundant fetches later
		this.latestKnownCommitSha = newCommitSha;
		this.latestKnownState = newState;

		return {
			changes,
			commitSha: newCommitSha,
			treeSha: newTreeSha,
			newState
		};
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
	async readFromSource(): Promise<VaultReadResult<"remote">> {
		const { commitSha, treeSha } = await this.getLatestCommitAndTreeSha();

		// Return cached state if remote hasn't changed
		if (commitSha === this.latestKnownCommitSha && this.latestKnownState !== null) {
			fitLogger.log(`... 📦 [RemoteVault] Using cached state (${commitSha.slice(0, 7)})`);
			return { state: { ...this.latestKnownState }, commitSha, treeSha };
		}

		// Fetch fresh state from GitHub
		if (this.latestKnownCommitSha === null) {
			fitLogger.log(`... ⬇️ [RemoteVault] Fetching initial state from GitHub (${commitSha.slice(0, 7)})...`);
		} else {
			fitLogger.log(`... ⬇️ [RemoteVault] New commit detected (${commitSha.slice(0, 7)}), fetching tree...`);
		}
		// Monitor for slow GitHub API operations
		const newState = await withSlowOperationMonitoring(
			this.buildStateFromTree(treeSha),
			`Remote vault tree fetch from GitHub`,
			{ warnAfterMs: 10000 }
		);

		// Update cache
		this.latestKnownCommitSha = commitSha;
		this.latestKnownState = newState;

		// Log completion with normalization diagnostics
		const normalizationInfo = detectNormalizationIssues(Object.keys(newState), 'remote (GitHub)');
		fitLogger.log(
			`... ☁️ [RemoteVault] Fetched ${Object.keys(newState).length} files`,
			normalizationInfo ? { nfdPaths: normalizationInfo.nfdCount } : undefined
		);

		return { state: { ...newState }, commitSha, treeSha };
	}

	/**
	 * Build FileStates from a tree SHA without reading commit metadata.
	 * Used after applyChanges() to construct state from the new tree.
	 *
	 * @param treeSha - Tree SHA to read
	 * @returns FileStates mapping paths to blob SHAs
	 */
	private async buildStateFromTree(treeSha: TreeSha): Promise<FileStates> {
		// Check if this is the empty tree - skip getTree() call (would return 404)
		const remoteTree: TreeNode[] = treeSha === EMPTY_TREE_SHA
			? []
			: await this.getTree(treeSha);

		const state: FileStates = {};
		const failedPaths: Array<{path: string, error: unknown}> = [];

		for (const node of remoteTree) {
			// Only include blobs (files), skip trees (directories)
			if (node.type === "blob" && node.path && node.sha) {
				try {
					// TODO: Should this notice if there's a collision overwriting same path?
					state[node.path] = node.sha;
				} catch (error) {
					failedPaths.push({ path: node.path, error });
					fitLogger.log(`❌ [RemoteVault] Failed to process file: ${node.path}`, error);
				}
			}
		}

		// If any files failed, throw a VaultError with details
		if (failedPaths.length > 0) {
			throw new VaultError(
				'network',
				`Failed to process ${failedPaths.length} file(s) from remote vault: ${failedPaths.map(f => f.path).join(', ')}`,
				{
					originalError: failedPaths[0].error,
					failedPaths: failedPaths.map(f => f.path),
					errors: failedPaths.map(f => ({ path: f.path, error: f.error }))
				}
			);
		}

		return state;
	}

}
