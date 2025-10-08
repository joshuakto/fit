/**
 * Test utilities for FIT plugin tests
 */

import { TFile } from 'obsidian';
import { TreeNode } from './remoteGitHubVault';

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
		// GET /repos/{owner}/{repo}/git/ref/{ref}
		if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
			const refName = params.ref;
			const commitSha = this.refs.get(refName);
			if (!commitSha) {
				throw new Error(`Ref not found: ${refName}`);
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
