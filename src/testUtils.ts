/**
 * Test utilities for FIT plugin tests
 */

import { TFile } from 'obsidian';
import { TreeNode } from './remoteGitHubVault';
import { ApplyChangesResult, IVault, VaultError, VaultReadResult } from './vault';
import { FileChange, FileStates } from "./util/changeTracking";
import { FileContent, Base64Content, Content, PlainTextContent, isBinaryExtension } from './util/contentEncoding';
import { extractExtension } from './utils';
import { BlobSha, CommitSha, computeSha1, TreeSha } from "./util/hashing";
import { LocalVault } from './localVault';

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
	private refs: Map<string, CommitSha> = new Map(); // ref name -> commit SHA
	private commits: Map<CommitSha, { tree: TreeSha; parents: CommitSha[]; message: string }> = new Map();
	private trees: Map<TreeSha, TreeNode[]> = new Map();
	private blobs: Map<BlobSha, string> = new Map(); // blob SHA -> content
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
	setupInitialState(commitSha: CommitSha, treeSha: TreeSha, tree: TreeNode[]): void {
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
	addBlob(sha: BlobSha, content: string): void {
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
	getLatestCommitSha(): CommitSha | undefined {
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
			const sha = this.hashContent(params.content) as BlobSha;
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

			const sha = this.hashContent(JSON.stringify(resultTree)) as TreeSha;
			this.trees.set(sha, resultTree);
			return { data: { sha } };
		}

		// POST /repos/{owner}/{repo}/git/commits
		if (route === "POST /repos/{owner}/{repo}/git/commits") {
			const { tree, parents, message } = params;
			const sha = this.hashContent(JSON.stringify({ tree, parents, message })) as CommitSha;
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
 * Scenarios where FakeLocalVault can be configured to fail.
 * Used for testing error handling.
 */
type FailureScenario = 'read' | 'stat' | 'write';

/**
 * Fake implementation of IVault for local testing.
 * Simulates a local vault with in-memory file storage.
 */
export class FakeLocalVault implements IVault<"local"> {
	private files: Map<string, FileContent> = new Map();
	private failureScenarios: Map<FailureScenario, Error> = new Map();
	private statLog: string[] = []; // Track all stat operations for performance testing

	/**
	 * Configure the vault to fail on a specific operation.
	 * @param scenario - Which operation should fail ('read', 'stat', 'write')
	 * @param error - The error to throw when that operation is attempted
	 */
	seedFailureScenario(scenario: FailureScenario, error: Error): void {
		this.failureScenarios.set(scenario, error);
	}

	/**
	 * Clear a specific failure scenario or all failures if no scenario specified.
	 */
	clearFailure(scenario?: FailureScenario): void {
		if (scenario) {
			this.failureScenarios.delete(scenario);
		} else {
			this.failureScenarios.clear();
		}
	}

	/**
	 * Set file content directly (for test setup).
	 */
	setFile(path: string, content: string | PlainTextContent | FileContent): void {
		// Normalize to logical encoding based on path (for convenient test assertions).
		const detectedExtension = extractExtension(path);
		const isBinary = detectedExtension && isBinaryExtension(detectedExtension);

		let fileContent: FileContent;
		if (content instanceof FileContent) {
			// Normalize: binary files stay as-is, text files convert to plaintext
			fileContent = isBinary ? content : FileContent.fromPlainText(content.toPlainText());
		} else {
			// Create FileContent from string: binary → base64, text → plaintext
			fileContent = isBinary
				? FileContent.fromBase64(Content.encodeToBase64(content))
				: FileContent.fromPlainText(content);
		}
		this.files.set(path, fileContent);
	}

	/**
	 * Get all files as raw PlainTextContent or Base64Content (for test assertions).
	 */
	getAllFilesAsRaw(): Record<string, Base64Content | PlainTextContent> {
		return Object.fromEntries([...this.files].map(
			([path, content]) => [path, content.toRaw().content]));
	}

	async readFromSource(): Promise<VaultReadResult<"local">> {
		const error = this.failureScenarios.get('read');
		if (error) {
			this.clearFailure('read');
			// Wrap in VaultError.filesystem to match real LocalVault behavior
			const message = error instanceof Error ? error.message : `Failed to read from source: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}

		const state: FileStates = {};
		for (const [path, content] of this.files.entries()) {
			if (this.shouldTrackState(path)) {
				state[path] = await LocalVault.fileSha1(path, content);
			}
		}
		return { state };
	}

	async readFileContent(path: string): Promise<FileContent> {
		const error = this.failureScenarios.get('read');
		if (error) {
			this.clearFailure('read');
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

	async statPaths(paths: string[]): Promise<Map<string, 'file' | 'folder' | null>> {
		// Track all stat operations (including duplicates) for performance testing
		this.statLog.push(...paths);

		// Check for seeded 'stat' failure scenario
		const statFailure = this.failureScenarios.get('stat');
		if (statFailure) {
			throw statFailure;
		}

		const stats = await Promise.all(
			paths.map(async (path) => {
				// Is it a file?
				if (this.files.has(path)) {
					return [path, 'file' as const] as const;
				}
				// Is it a folder? (any file starts with "path/")
				for (const filePath of this.files.keys()) {
					if (filePath.startsWith(path + '/')) {
						return [path, 'folder' as const] as const;
					}
				}
				return [path, null] as const;
			})
		);
		return new Map(stats);
	}

	/**
	 * Get the log of all stat operations performed (for performance testing).
	 */
	getStatLog(): string[] {
		return [...this.statLog];
	}

	/**
	 * Clear the stat log (useful between test phases).
	 */
	clearStatLog(): void {
		this.statLog = [];
	}

	/**
	 * Clear all files from the vault (useful for test setup).
	 */
	clear(): void {
		this.files.clear();
		this.statLog = [];
	}

	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>
	): Promise<ApplyChangesResult<"local">> {
		const error = this.failureScenarios.get('write');
		if (error) {
			this.clearFailure('write');
			// Wrap in VaultError.filesystem to match real LocalVault behavior
			const message = error instanceof Error ? error.message : `Failed to apply changes: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}

		const changes: FileChange[] = [];

		for (const file of filesToWrite) {
			// Simulate file/folder conflicts that occur in real filesystems:
			// 1. Can't create file "foo" if folder "foo/" exists (has files like "foo/bar")
			// 2. Can't create file "foo/bar" if file "foo" exists (would need folder "foo/")

			const existingPaths = Array.from(this.files.keys());

			// Check #1: File path conflicts with existing folder
			if (existingPaths.some(p => p.startsWith(file.path + '/'))) {
				throw VaultError.filesystem(
					`Cannot create file "${file.path}" - a folder with this name already exists`
				);
			}

			// Check #2: Parent folder path conflicts with existing file
			const parentFolder = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : null;
			if (parentFolder && this.files.has(parentFolder)) {
				throw VaultError.filesystem(
					`Cannot create folder "${parentFolder}" for file "${file.path}" - a file with this name already exists`
				);
			}

			const existed = this.files.has(file.path);
			this.setFile(file.path, file.content);
			changes.push({ path: file.path, type: existed ? 'MODIFIED' : 'ADDED' });
		}

		for (const path of filesToDelete) {
			if (this.files.has(path)) {
				this.files.delete(path);
				changes.push({ path, type: 'REMOVED' });
			}
		}

		// Start computing SHAs for written files asynchronously (for later retrieval)
		// Only for trackable files that will appear in future scans
		const writtenStates = this.computeWrittenFileShas(filesToWrite);

		return {
			changes,
			writtenStates
		};
	}

	/**
	 * Compute SHAs for files that were just written.
	 * Only tracks files that shouldTrackState (will appear in future scans).
	 */
	private async computeWrittenFileShas(
		filesToWrite: Array<{path: string, content: FileContent}>
	): Promise<FileStates> {
		const shaPromises = filesToWrite
			.filter(({path}) => this.shouldTrackState(path))
			.map(async ({path, content}) => {
				const sha = await LocalVault.fileSha1(path, content);
				return [path, sha] as const;
			});

		const results = await Promise.all(shaPromises);
		return Object.fromEntries(results);
	}

	shouldTrackState(path: string): boolean {
		// Exclude hidden files (same as LocalVault)
		const parts = path.split('/');
		return !parts.some(part => part.startsWith('.'));
	}
}

/**
 * Fake implementation of IVault for remote testing.
 * Simulates a remote vault (like GitHub) with in-memory file storage and commit tracking.
 */
export class FakeRemoteVault implements IVault<"remote"> {
	private files: Map<string, FileContent> = new Map();
	private blobShas: Map<BlobSha, Base64Content> = new Map(); // blob SHA -> content
	private commitSha: CommitSha = 'initial-commit' as CommitSha;
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
	 * Clear all files from the vault (useful for test setup).
	 */
	clear(): void {
		this.files.clear();
		this.blobShas.clear();
		// Don't reset commitSha - it auto-increments
	}

	/**
	 * Set file content directly (for test setup).
	 */
	async setFile(path: string, content: string | FileContent): Promise<void> {
		let fileContent;
		if (content instanceof FileContent) {
			fileContent = content;
		} else {
			fileContent = FileContent.fromPlainText(content);
		}
		this.files.set(path, fileContent);
		// Store blob SHA -> content mapping for readFileContent
		const sha = await computeSha1(path + fileContent.toBase64()) as BlobSha;
		this.blobShas.set(sha, fileContent.toBase64());
	}

	/**
	 * Get file content directly (for test assertions).
	 */
	getFile(path: string): string | undefined {
		return this.files.get(path)?.toPlainText();
	}

	/**
	 * Get all files as raw PlainTextContent or Base64Content (for test assertions).
	 */
	getAllFilesAsRaw(): Record<string, Base64Content | PlainTextContent> {
		return Object.fromEntries([...this.files].map(
			([path, content]) => [path, content.toRaw().content]));
	}

	/**
	 * Get current commit SHA (for test assertions).
	 */
	getCommitSha(): CommitSha {
		return this.commitSha;
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
	 * Build FileStates from current files in the fake vault.
	 * Computes SHAs consistently for both readFromSource and buildStateFromTree.
	 *
	 * @param storeBlobShaMapping - If true, stores blob SHA -> content mapping for readFileContent
	 * @returns FileStates mapping paths to blob SHAs
	 */
	private async buildCurrentState(storeBlobShaMapping: boolean): Promise<FileStates> {
		const state: FileStates = {};
		for (const [path, content] of this.files.entries()) {
			if (this.shouldTrackState(path)) {
				const base64Content = content.toBase64();
				const sha = await computeSha1(path + base64Content) as BlobSha;
				state[path] = sha;
				// Store blob SHA -> content mapping for readFileContent if requested
				if (storeBlobShaMapping) {
					this.blobShas.set(sha, base64Content);
				}
			}
		}
		return state;
	}

	async readFromSource(): Promise<VaultReadResult<"remote">> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			throw error;
		}

		const state = await this.buildCurrentState(true);
		return { state, commitSha: this.commitSha };
	}

	async readFileContent(path: string): Promise<FileContent> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			throw error;
		}

		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`File not found: ${path}`);
		}
		// Convert to base64 to match GitHub API behavior.
		return FileContent.fromBase64(content.toBase64());
	}

	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>
	): Promise<ApplyChangesResult<"remote">> {
		if (this.failureError) {
			const error = this.failureError;
			this.clearFailure();
			throw error;
		}

		const changes: FileChange[] = [];

		for (const file of filesToWrite) {
			const existed = this.files.has(file.path);
			this.setFile(file.path, file.content);
			changes.push({ path: file.path, type: existed ? 'MODIFIED' : 'ADDED' });
		}

		for (const path of filesToDelete) {
			if (this.files.has(path)) {
				this.files.delete(path);
				changes.push({ path, type: 'REMOVED' });
			}
		}

		// Update commit SHA to simulate a new commit
		// Compute stable hash from sorted file paths and their base64 content
		this.commitSha = await computeSha1(
			Array.from(this.files.entries())
				.map(([path, content]) => `${path}:${content.toBase64()}`)
				.join('\n')
		) as CommitSha;

		// Compute tree SHA from file list (simulates GitHub tree object)
		const treeSha = await computeSha1(
			Array.from(this.files.keys()).sort().join('\n')
		) as TreeSha;

		// Build new state from current files (consistent with real vault)
		// In tests, tree SHA doesn't matter - just return current state
		// This mimics RemoteGitHubVault.buildStateFromTree behavior
		const newState = await this.buildCurrentState(false);

		return {
			changes: changes,
			commitSha: this.commitSha,
			treeSha,
			newState
		};
	}

	shouldTrackState(_path: string): boolean {
		// No filtering for remote vault
		return true;
	}
}
