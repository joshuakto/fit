/**
 * Test utilities for FIT plugin tests
 */

import { TFile } from 'obsidian';
import { TreeNode } from './remoteGitHubVault';
import { ApplyChangesResult, IVault, VaultError, VaultReadResult } from './vault';
import { FileChange, FileStates } from "./util/changeTracking";
import { FileContent, Base64Content, PlainTextContent } from './util/contentEncoding';
import { FilePath } from './util/filePath';
import { BlobSha, CommitSha, computeSha1, TreeSha } from "./util/hashing";
import { LocalVault } from './localVault';
import { fitLogger } from './logger';

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

		const name = FilePath.getName(FilePath.create(filePath));
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

		// Add default stat with size 0 (tests can override if needed)
		stub.stat = { size: 0, mtime: 0, ctime: 0 };

		return stub as TFile;
	}
}

/**
 * Fake Obsidian vault that simulates the real Obsidian behavior:
 * - vault index (getAbstractFileByPath) does NOT include hidden files
 * - adapter (filesystem) DOES include all files
 * - vault.create/modify/delete work only for indexed (non-hidden) files
 *
 * This is more realistic than simple mocks and can be used across test files.
 */
export class FakeObsidianVault {
	private filesOnDisk = new Map<string, string>(); // path -> content
	private vaultIndex = new Set<string>(); // Paths in vault index (non-hidden)

	getAbstractFileByPath(path: string) {
		// Simulate: vault index never returns hidden files
		if (path.startsWith('.') || !this.vaultIndex.has(path)) return null;
		return { path } as TFile;
	}

	adapter = {
		stat: async (path: string) => {
			if (this.filesOnDisk.has(path)) {
				return { type: 'file', size: this.filesOnDisk.get(path)!.length, ctime: 0, mtime: 0 };
			}
			throw new Error('ENOENT: no such file');
		},
		readBinary: async (path: string) => {
			const content = this.filesOnDisk.get(path);
			if (!content) throw new Error('ENOENT: no such file');
			return new TextEncoder().encode(content).buffer;
		},
		write: async (path: string, data: string) => {
			this.filesOnDisk.set(path, data);
		},
		remove: async (path: string) => {
			this.filesOnDisk.delete(path);
		}
	};

	// Vault methods (work only for indexed files)
	readBinary = async (file: TFile) => {
		const content = this.filesOnDisk.get(file.path);
		if (!content) throw new Error('File not found');
		return new TextEncoder().encode(content).buffer;
	};

	create = async (path: string, data: string) => {
		if (this.filesOnDisk.has(path)) throw new Error('File already exists.');
		this.filesOnDisk.set(path, data);
		if (!path.startsWith('.')) this.vaultIndex.add(path);
	};

	createBinary = async (path: string, data: ArrayBuffer) => {
		if (this.filesOnDisk.has(path)) throw new Error('File already exists.');
		this.filesOnDisk.set(path, new TextDecoder().decode(data));
		if (!path.startsWith('.')) this.vaultIndex.add(path);
	};

	modify = async (file: TFile, data: string) => {
		this.filesOnDisk.set(file.path, data);
	};

	modifyBinary = async (file: TFile, data: ArrayBuffer) => {
		this.filesOnDisk.set(file.path, new TextDecoder().decode(data));
	};

	delete = async (file: TFile) => {
		this.filesOnDisk.delete(file.path);
		this.vaultIndex.delete(file.path);
	};

	getFiles = () => Array.from(this.vaultIndex).map(path => ({ path } as TFile));
	createFolder = async () => {};
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
/**
 * Create an HTTP error with status code that wrapOctokitError will recognize
 */
function createHttpError(message: string, status: number): Error {
	const error: any = new Error(message);
	error.status = status;
	error.response = {}; // Simulate response object for wrapOctokitError
	return error;
}

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
				throw createHttpError(`Repository not found`, 404);
			}
			return { data: { name: this.repo, owner: { login: this.owner } } };
		}

		// GET /repos/{owner}/{repo}/git/ref/{ref}
		if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
			const refName = params.ref;
			const commitSha = this.refs.get(refName);
			if (!commitSha) {
				throw createHttpError(`Ref not found: ${refName}`, 404);
			}
			return { data: { object: { sha: commitSha } } };
		}

		// GET /repos/{owner}/{repo}/commits/{ref}
		if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
			const ref = params.ref;
			// Try to resolve ref as a branch name first, then as a commit SHA
			let commitSha = this.refs.get(`heads/${ref}`);
			if (!commitSha) {
				// Not a branch, try as a direct commit SHA
				commitSha = ref as CommitSha;
			}
			const commit = this.commits.get(commitSha);
			if (!commit) {
				throw createHttpError(`Commit not found: ${ref}`, 404);
			}
			return { data: { sha: commitSha, commit: { tree: { sha: commit.tree } } } };
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
	private mockWriteFile: ((path: string) => Promise<void>) | null = null; // Mock for writeFile operations

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
	 * Set a mock function to be called during writeFile operations.
	 * Allows test code to inject failures for specific paths.
	 * @param mockFn - Function called with path before writing. Should throw to simulate failure, or null to clear.
	 */
	setMockWriteFile(mockFn: ((path: string) => Promise<void>) | null): void {
		this.mockWriteFile = mockFn;
	}

	/**
	 * Set file content directly (for test setup).
	 * Simulates Obsidian's storage behavior:
	 * - Text files: stored as plaintext (decodes base64 if needed)
	 * - Binary files: stored as base64 (detected via decoding failure or null bytes)
	 */
	setFile(path: string, content: string | PlainTextContent | FileContent): void {
		if (!(content instanceof FileContent)) {
			// Raw string, treat as plaintext
			this.files.set(path, FileContent.fromPlainText(content));
			return;
		}

		const raw = content.toRaw();
		if (raw.encoding === 'plaintext') {
			// Already plaintext, store as-is
			this.files.set(path, content);
			return;
		}

		// Base64 content - try to decode as text (simulates Obsidian's behavior)
		try {
			const decoded = content.toPlainText();
			// Check for null bytes (binary indicator)
			if (decoded.includes('\0')) {
				// Binary file, keep as base64
				this.files.set(path, content);
			} else {
				// Valid text, store as plaintext
				this.files.set(path, FileContent.fromPlainText(decoded));
			}
		} catch {
			// Decoding failed - binary file, keep as base64
			this.files.set(path, content);
		}
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

		// Use Promise.allSettled to collect all file processing results
		const paths = Array.from(this.files.keys()).filter(path => this.shouldTrackState(path));
		const settledResults = await Promise.allSettled(
			paths.map(async (path) => {
				// Call mock if provided (allows test to inject failures)
				if (this.mockWriteFile) {
					await this.mockWriteFile(path);
				}

				const content = this.files.get(path)!;
				const sha = await LocalVault.fileSha1(path, content);
				return { path, sha };
			})
		);

		// Collect successful results and failures
		const state: FileStates = {};
		const failedPaths: string[] = [];
		const errors: Array<{ path: string; error: unknown }> = [];

		for (let i = 0; i < settledResults.length; i++) {
			const result = settledResults[i];
			const path = paths[i];

			if (result.status === 'fulfilled') {
				state[result.value.path] = result.value.sha;
			} else {
				fitLogger.log(`❌ [LocalVault] Failed to process file: ${path}`, result.reason);
				failedPaths.push(path);
				errors.push({ path, error: result.reason });
			}
		}

		// If any files failed, throw VaultError with details
		if (failedPaths.length > 0) {
			throw VaultError.filesystem(
				`Failed to read ${failedPaths.length} file(s) from local vault`,
				{
					failedPaths,
					errors
				}
			);
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
		filesToDelete: Array<string>,
		options?: { clashPaths?: Set<string> }
	): Promise<ApplyChangesResult<"local">> {
		const clashPaths = options?.clashPaths ?? new Set();
		const error = this.failureScenarios.get('write');
		if (error) {
			this.clearFailure('write');
			// Wrap in VaultError.filesystem to match real LocalVault behavior
			const message = error instanceof Error ? error.message : `Failed to apply changes: ${String(error)}`;
			throw VaultError.filesystem(message, { originalError: error });
		}

		// Use Promise.allSettled to match real LocalVault behavior
		const writeSettledResults = await Promise.allSettled(
			filesToWrite.map(async (file) => {
				// If path is in clashPaths, write to _fit/ subdirectory (like real LocalVault)
				const writePath = clashPaths.has(file.path) ? `_fit/${file.path}` : file.path;

				// Call mock if provided (allows test to inject failures)
				if (this.mockWriteFile) {
					await this.mockWriteFile(writePath);
				}

				// Simulate file/folder conflicts that occur in real filesystems:
				// 1. Can't create file "foo" if folder "foo/" exists (has files like "foo/bar")
				// 2. Can't create file "foo/bar" if file "foo" exists (would need folder "foo/")

				const existingPaths = Array.from(this.files.keys());

				// Check #1: File path conflicts with existing folder
				if (existingPaths.some(p => p.startsWith(writePath + '/'))) {
					throw VaultError.filesystem(
						`Cannot create file "${writePath}" - a folder with this name already exists`
					);
				}

				// Check #2: Parent folder path conflicts with existing file
				const parentFolder = writePath.includes('/') ? writePath.substring(0, writePath.lastIndexOf('/')) : null;
				if (parentFolder && this.files.has(parentFolder)) {
					throw VaultError.filesystem(
						`Cannot create folder "${parentFolder}" for file "${writePath}" - a file with this name already exists`
					);
				}

				const existed = this.files.has(writePath);
				this.setFile(writePath, file.content);
				const changeType: 'MODIFIED' | 'ADDED' = existed ? 'MODIFIED' : 'ADDED';
				// Return FileChange with write path (matches real LocalVault)
				return { path: writePath, type: changeType };
			})
		);

		// Collect successful writes and failures
		const writeResults: FileChange[] = [];
		const writeFailures: Array<{path: string; error: unknown}> = [];

		for (let i = 0; i < writeSettledResults.length; i++) {
			const result = writeSettledResults[i];
			const {path} = filesToWrite[i];

			if (result.status === 'fulfilled') {
				writeResults.push(result.value);
			} else {
				writeFailures.push({ path, error: result.reason });
			}
		}

		// Process deletions
		const deletionResults: FileChange[] = [];
		for (const path of filesToDelete) {
			if (this.files.has(path)) {
				this.files.delete(path);
				deletionResults.push({ path, type: 'REMOVED' });
			}
		}

		// If any operations failed, throw VaultError with details
		if (writeFailures.length > 0) {
			const failedPaths = writeFailures.map(f => f.path);
			const primaryPath = failedPaths[0];
			const primaryError = writeFailures[0].error;
			const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);

			throw VaultError.filesystem(
				`Failed to write to ${primaryPath}: ${primaryMessage}`,
				{
					failedPaths,
					errors: writeFailures
				}
			);
		}

		const changes = [...writeResults, ...deletionResults];

		// Start computing SHAs for written files asynchronously (for later retrieval)
		// Only for trackable files that will appear in future scans
		const newBaselineStates = this.computeWrittenFileShas(filesToWrite, clashPaths);

		return {
			changes,
			newBaselineStates
		};
	}

	/**
	 * Compute SHAs for files that were just written.
	 * Mirrors LocalVault behavior: computes for direct writes + untracked clashes to enable baseline tracking (#169).
	 * Tracked clash files self-heal via local scan, so SHAs are not computed for them.
	 * Uses pathForSha to compute SHA for original path when file written as clash.
	 */
	private async computeWrittenFileShas(
		filesToWrite: Array<{path: string, content: FileContent}>,
		clashPaths: Set<string>
	): Promise<FileStates> {
		const shaPromises = filesToWrite
			.map(async ({path, content}) => {
				const writePath = clashPaths.has(path) ? `_fit/${path}` : path;
				const shaPath = clashPaths.has(path) ? path : undefined;
				const pathForSha = shaPath ?? writePath;

				// Only compute SHA for:
				// 1. Direct writes (shaPath === undefined), OR
				// 2. Untracked clash files (shaPath defined AND !shouldTrackState)
				// Tracked clash files self-heal via local scan, so skip SHA computation
				if (shaPath === undefined || !this.shouldTrackState(pathForSha)) {
					const sha = await LocalVault.fileSha1(pathForSha, content);
					return [path, sha] as const;
				}
				return null;
			});

		const results = await Promise.all(shaPromises);
		return Object.fromEntries(results.filter((r): r is [string, BlobSha] => r !== null));
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
		// Mock tree SHA - not accurate but sufficient for testing
		const treeSha = `tree-${this.commitSha}` as TreeSha;
		return { state, commitSha: this.commitSha, treeSha };
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
		filesToDelete: Array<string>,
		_options?: { clashPaths?: Set<string> }
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
