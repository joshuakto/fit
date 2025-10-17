/**
 * Test utilities for FIT plugin tests
 */

import { TFile } from 'obsidian';
import { TreeNode } from './remoteGitHubVault';
import { VaultError } from './vault';

/**
 * Test stub for TFile that can be constructed with just a path.
 *
 * Note: Obsidian vault paths always use forward slashes, even on Windows.
 *
 * Usage:
 *   const file = StubTFile.ofPath('folder/note.md');
 *   // file.path = 'folder/note.md'
 *   // file.extension = 'md'
 *   // file.basename = 'note'
 *   // file.name = 'note.md'
 */
export class StubTFile extends TFile {
	/**
	 * Create a StubTFile from a file path.
	 * Automatically parses path to populate all TFile properties.
	 */
	static ofPath(filePath: string): TFile {
		const stub = Object.create(TFile.prototype);

		stub.path = filePath;

		// Extract name (last component) from forward-slash path
		const name = filePath.split('/').pop()!;
		stub.name = name;

		// Extract extension (everything after last dot)
		const lastDot = name.lastIndexOf('.');
		if (lastDot > 0) {
			stub.extension = name.substring(lastDot + 1);
			stub.basename = name.substring(0, lastDot);
		} else {
			stub.extension = '';
			stub.basename = name;
		}

		return stub as TFile;
	}
}

/**
 * Fake implementation of Octokit for testing RemoteGitHubVault.
 * Maintains internal state (refs, commits, trees, blobs) and responds to requests intelligently.
 *
 * Usage:
 *   const fake = new FakeOctokit("owner", "repo");
 *   fake.setupInitialState("commit123", "tree456", [
 *     { path: "file.md", type: "blob", mode: "100644", sha: "sha1" }
 *   ]);
 *   fake.addBlob("sha1", "file content");
 *
 *   // Now use fake.request() which will respond based on internal state
 *   const vault = new RemoteGitHubVault(fake as any, "owner", "repo", "main", ...);
 */
export class FakeOctokit {
	private refs: Map<string, string> = new Map(); // ref name -> commit SHA
	private commits: Map<string, { tree: string; parents: string[]; message: string }> = new Map();
	private trees: Map<string, TreeNode[]> = new Map();
	private blobs: Map<string, string> = new Map(); // blob SHA -> content
	private repoExists: boolean = true; // Simulate whether repository exists
	private errorSimulations: Map<string, Error> = new Map(); // route -> error to throw

	constructor(
		public owner: string,
		public repo: string,
		public branch: string = "main"
	) {}

	/**
	 * Set up initial repository state with a commit and tree.
	 */
	setupInitialState(commitSha: string, treeSha: string, tree: TreeNode[]): void {
		this.refs.set(`heads/${this.branch}`, commitSha);
		this.commits.set(commitSha, { tree: treeSha, parents: [], message: "Initial commit" });
		this.trees.set(treeSha, tree);
	}

	/**
	 * Set whether repository exists (for simulating 404 errors).
	 */
	setRepoExists(exists: boolean): void {
		this.repoExists = exists;
	}

	/**
	 * Simulate an error for a specific route.
	 * The next call to this route will throw the specified error.
	 */
	simulateError(route: string, error: Error): void {
		this.errorSimulations.set(route, error);
	}

	/**
	 * Add a blob to the fake repository.
	 */
	addBlob(sha: string, content: string): void {
		this.blobs.set(sha, content);
	}

	/**
	 * Get the current tree for the branch.
	 */
	getCurrentTree(): TreeNode[] | undefined {
		const commitSha = this.refs.get(`heads/${this.branch}`);
		if (!commitSha) return undefined;

		const commit = this.commits.get(commitSha);
		if (!commit) return undefined;

		return this.trees.get(commit.tree);
	}

	/**
	 * Get the latest commit SHA for the branch.
	 */
	getLatestCommitSha(): string | undefined {
		return this.refs.get(`heads/${this.branch}`);
	}

	/**
	 * Octokit request method - routes requests to appropriate handlers.
	 */
	request = async (route: string, params?: any): Promise<{ data: any }> => {
		// Check for simulated errors first
		const simulatedError = this.errorSimulations.get(route);
		if (simulatedError) {
			this.errorSimulations.delete(route); // Clear after throwing once
			throw simulatedError;
		}

		// GET /repos/{owner}/{repo}
		if (route === "GET /repos/{owner}/{repo}") {
			if (!this.repoExists) {
				const error: any = new Error(`Repository not found`);
				error.status = 404;
				error.response = {}; // Simulate response object for wrapOctokitError
				throw error;
			}
			return { data: { name: this.repo, owner: { login: this.owner } } };
		}

		// GET /repos/{owner}/{repo}/git/ref/{ref}
		if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
			const refName = params.ref;
			const commitSha = this.refs.get(refName);
			if (!commitSha) {
				const error: any = new Error(`Ref not found: ${refName}`);
				error.status = 404;
				error.response = {}; // Simulate response object for wrapOctokitError
				throw error;
			}
			return { data: { object: { sha: commitSha } } };
		}

		// GET /repos/{owner}/{repo}/commits/{ref}
		if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
			const commitSha = params.ref;
			const commit = this.commits.get(commitSha);
			if (!commit) {
				throw new Error(`Commit not found: ${commitSha}`);
			}
			return { data: { commit: { tree: { sha: commit.tree } } } };
		}

		// GET /repos/{owner}/{repo}/git/trees/{tree_sha}
		if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
			const treeSha = params.tree_sha;
			const tree = this.trees.get(treeSha);
			if (!tree) {
				throw new Error(`Tree not found: ${treeSha}`);
			}
			return { data: { tree } };
		}

		// GET /repos/{owner}/{repo}/git/blobs/{file_sha}
		if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
			const blobSha = params.file_sha;
			const content = this.blobs.get(blobSha);
			if (!content) {
				throw new Error(`Blob not found: ${blobSha}`);
			}
			return { data: { content } };
		}

		// POST /repos/{owner}/{repo}/git/blobs
		if (route === "POST /repos/{owner}/{repo}/git/blobs") {
			// Create a simple hash from content for deterministic SHA generation
			const sha = this.hashContent(params.content);
			this.blobs.set(sha, params.content);
			return { data: { sha } };
		}

		// POST /repos/{owner}/{repo}/git/trees
		if (route === "POST /repos/{owner}/{repo}/git/trees") {
			const baseTreeSha = params.base_tree;
			const newNodes: TreeNode[] = params.tree;

			// Start with base tree or empty
			let resultTree: TreeNode[] = baseTreeSha ? [...(this.trees.get(baseTreeSha) || [])] : [];

			// Apply changes from new nodes
			for (const node of newNodes) {
				if (node.sha === null) {
					// Deletion: remove from tree
					resultTree = resultTree.filter(n => n.path !== node.path);
				} else {
					// Addition or modification: replace or add
					const existingIndex = resultTree.findIndex(n => n.path === node.path);
					if (existingIndex >= 0) {
						resultTree[existingIndex] = node;
					} else {
						resultTree.push(node);
					}
				}
			}

			const sha = this.hashContent(JSON.stringify(resultTree));
			this.trees.set(sha, resultTree);
			return { data: { sha } };
		}

		// POST /repos/{owner}/{repo}/git/commits
		if (route === "POST /repos/{owner}/{repo}/git/commits") {
			const { tree, parents, message } = params;
			const sha = this.hashContent(JSON.stringify({ tree, parents, message }));
			this.commits.set(sha, { tree, parents, message });
			return { data: { sha } };
		}

		// PATCH /repos/{owner}/{repo}/git/refs/{ref}
		if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
			const refName = params.ref;
			const sha = params.sha;
			this.refs.set(refName, sha);
			return { data: { object: { sha } } };
		}

		throw new Error(`Unhandled request: ${route}`);
	};

	/**
	 * Simple hash function for generating deterministic SHAs from content.
	 * Public so tests can compute expected SHAs.
	 */
	hashContent(content: string): string {
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash).toString(16).padStart(40, '0');
	}
}

/**
 * Fake implementation of IVault for local testing.
 * Simulates a local vault with in-memory file storage.
 */
export class FakeLocalVault {
	private files: Map<string, string> = new Map(); // path -> content
	private failureError: Error | null = null;

	/**
	 * Set the vault to fail on the next operation.
	 */
	setFailure(error: Error): void {
		this.failureError = error;
	}

	/**
	 * Clear any pending failure.
	 */
	clearFailure(): void {
		this.failureError = null;
	}

	/**
	 * Set file content directly (for test setup).
	 */
	setFile(path: string, content: string): void {
		this.files.set(path, content);
	}

	/**
	 * Get file content directly (for test assertions).
	 */
	getFile(path: string): string | undefined {
		return this.files.get(path);
	}

	/**
	 * Get all file paths (for test assertions).
	 */
	getAllPaths(): string[] {
		return Array.from(this.files.keys());
	}

	async readFromSource(): Promise<Record<string, string>> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			// Wrap in VaultError.filesystem to match real LocalVault behavior
			const message = error instanceof Error ? error.message : `Failed to read from source: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}

		const state: Record<string, string> = {};
		for (const [path, content] of this.files.entries()) {
			if (this.shouldTrackState(path)) {
				state[path] = await this.computeSha(content);
			}
		}
		return state;
	}

	async readFileContent(path: string): Promise<string> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			// Wrap in VaultError.filesystem to match real LocalVault behavior
			const message = error instanceof Error ? error.message : `Failed to read file content: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}

		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`File not found: ${path}`);
		}
		return content;
	}

	async applyChanges(
		filesToWrite: Array<{path: string, content: string}>,
		filesToDelete: Array<string>
	): Promise<Array<{path: string, status: string}>> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			// Wrap in VaultError.filesystem to match real LocalVault behavior
			const message = error instanceof Error ? error.message : `Failed to apply changes: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}

		const ops: Array<{path: string, status: string}> = [];

		for (const file of filesToWrite) {
			const existed = this.files.has(file.path);
			this.files.set(file.path, file.content);
			ops.push({ path: file.path, status: existed ? 'modified' : 'created' });
		}

		for (const path of filesToDelete) {
			if (this.files.has(path)) {
				this.files.delete(path);
				ops.push({ path, status: 'deleted' });
			}
		}

		return ops;
	}

	shouldTrackState(path: string): boolean {
		// Exclude hidden files (same as LocalVault)
		const parts = path.split('/');
		return !parts.some(part => part.startsWith('.'));
	}

	private async computeSha(content: string): Promise<string> {
		const enc = new TextEncoder();
		const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(content));
		const hashArray = Array.from(new Uint8Array(hashBuf));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}
}

/**
 * Fake implementation of IVault for remote testing.
 * Simulates a remote vault (like GitHub) with in-memory file storage and commit tracking.
 */
export class FakeRemoteVault {
	private files: Map<string, string> = new Map(); // path -> content
	private blobShas: Map<string, string> = new Map(); // blob SHA -> content
	private commitSha: string = 'initial-commit';
	private failureError: Error | null = null;
	private owner: string;
	private repo: string;
	private branch: string;

	constructor(owner: string, repo: string, branch: string) {
		this.owner = owner;
		this.repo = repo;
		this.branch = branch;
	}

	/**
	 * Set the vault to fail on the next operation.
	 */
	setFailure(error: Error): void {
		this.failureError = error;
	}

	/**
	 * Clear any pending failure.
	 */
	clearFailure(): void {
		this.failureError = null;
	}

	/**
	 * Set file content directly (for test setup).
	 */
	async setFile(path: string, content: string): Promise<void> {
		this.files.set(path, content);
		// Store blob SHA -> content mapping for readFileContent
		const sha = await this.computeSha(content);
		this.blobShas.set(sha, content);
	}

	/**
	 * Get file content directly (for test assertions).
	 */
	getFile(path: string): string | undefined {
		return this.files.get(path);
	}

	/**
	 * Get all file paths (for test assertions).
	 */
	getAllPaths(): string[] {
		return Array.from(this.files.keys());
	}

	/**
	 * Get current commit SHA (for test assertions).
	 */
	getCommitSha(): string {
		return this.commitSha;
	}

	/**
	 * Get the latest commit SHA (implements RemoteGitHubVault interface).
	 */
	async getLatestCommitSha(): Promise<string> {
		return this.commitSha;
	}

	/**
	 * Get tree SHA from a commit (stub for RemoteGitHubVault compatibility).
	 */
	async getCommitTreeSha(_ref: string): Promise<string> {
		// Return a fake tree SHA based on current state
		return await this.computeSha(JSON.stringify(Array.from(this.files.keys())));
	}

	/**
	 * Get tree nodes (stub for RemoteGitHubVault compatibility).
	 */
	async getTree(_treeSha: string): Promise<any[]> {
		// Return empty tree for now - can be enhanced later if needed
		return [];
	}

	/**
	 * Get owner (returns value from constructor).
	 */
	getOwner(): string {
		return this.owner;
	}

	/**
	 * Get repo (returns value from constructor).
	 */
	getRepo(): string {
		return this.repo;
	}

	/**
	 * Get branch (returns value from constructor).
	 */
	getBranch(): string {
		return this.branch;
	}

	/**
	 * Create tree node from content (stub for RemoteGitHubVault compatibility).
	 * This method stores the content in the fake vault.
	 */
	async createTreeNodeFromContent(path: string, content: string, _remoteTree: any[], _encoding?: string): Promise<any> {
		// Store the file content so it persists in the fake vault
		this.files.set(path, content);
		const sha = await this.computeSha(content);
		// Store blob SHA -> content mapping for readFileContent
		this.blobShas.set(sha, content);
		return { path, sha, mode: '100644', type: 'blob' };
	}

	async readFromSource(): Promise<Record<string, string>> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			throw error;
		}

		const state: Record<string, string> = {};
		for (const [path, content] of this.files.entries()) {
			if (this.shouldTrackState(path)) {
				const sha = await this.computeSha(content);
				state[path] = sha;
				// Store blob SHA -> content mapping for readFileContent
				this.blobShas.set(sha, content);
			}
		}
		return state;
	}

	/**
	 * Read from source at a specific commit (for compatibility with RemoteGitHubVault).
	 * For fake vault, just delegate to readFromSource (ignore commit SHA).
	 */
	async readFromSourceAtCommit(_commitSha: string): Promise<Record<string, string>> {
		return this.readFromSource();
	}

	async readFileContent(pathOrSha: string): Promise<string> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			throw error;
		}

		// Check if it's a blob SHA first (real RemoteGitHubVault uses blob SHAs)
		const blobContent = this.blobShas.get(pathOrSha);
		if (blobContent !== undefined) {
			return blobContent;
		}

		// Fall back to path-based lookup (for backward compatibility)
		const pathContent = this.files.get(pathOrSha);
		if (pathContent === undefined) {
			throw new Error(`File not found: ${pathOrSha}`);
		}
		return pathContent;
	}

	async applyChanges(
		filesToWrite: Array<{path: string, content: string}>,
		filesToDelete: Array<string>
	): Promise<Array<{path: string, status: string}>> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			throw error;
		}

		const ops: Array<{path: string, status: string}> = [];

		for (const file of filesToWrite) {
			const existed = this.files.has(file.path);
			this.files.set(file.path, file.content);
			// Store blob SHA -> content mapping for readFileContent
			const sha = await this.computeSha(file.content);
			this.blobShas.set(sha, file.content);
			ops.push({ path: file.path, status: existed ? 'modified' : 'created' });
		}

		for (const path of filesToDelete) {
			if (this.files.has(path)) {
				this.files.delete(path);
				ops.push({ path, status: 'deleted' });
			}
		}

		// Update commit SHA to simulate a new commit
		this.commitSha = await this.computeSha(
			Array.from(this.files.entries())
				.map(([path, content]) => `${path}:${content}`)
				.join('\n')
		);

		return ops;
	}

	shouldTrackState(_path: string): boolean {
		// No filtering for remote vault
		return true;
	}

	private async computeSha(content: string): Promise<string> {
		const enc = new TextEncoder();
		const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(content));
		const hashArray = Array.from(new Uint8Array(hashBuf));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}
}
