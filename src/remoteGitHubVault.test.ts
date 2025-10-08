/**
 * Tests for RemoteGitHubVault
 */

import { RemoteGitHubVault, TreeNode } from "./remoteGitHubVault";
import { FileState } from "./vault";
import { EMPTY_TREE_SHA } from "./utils";
import { FakeOctokit } from "./testUtils";
import { __setMockOctokitInstance } from "./__mocks__/@octokit/core";

describe("RemoteGitHubVault", () => {
	let fakeOctokit: FakeOctokit;
	let vault: RemoteGitHubVault;

	beforeEach(() => {
		fakeOctokit = new FakeOctokit("testowner", "testrepo", "main");
		__setMockOctokitInstance(fakeOctokit);

		vault = new RemoteGitHubVault(
			"fake-pat-token",
			"testowner",
			"testrepo",
			"main",
			"test-device"
		);
	});

	describe("Read Operations", () => {
		describe("getCommitTreeSha", () => {
			it("should fetch tree SHA from commit", async () => {
				fakeOctokit.setupInitialState("commit123", "tree456", []);

				const treeSha = await vault.getCommitTreeSha("commit123");

				expect(treeSha).toBe("tree456");
			});
		});

		describe("getTree", () => {
			it("should fetch tree nodes from GitHub", async () => {
				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" },
					{ path: "file2.md", type: "blob", mode: "100644", sha: "sha2" }
				];

				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);

				const tree = await vault.getTree("tree456");

				expect(tree).toEqual(mockTree);
			});
		});

		describe("computeCurrentState", () => {
			it("should compute state from non-empty tree", async () => {
				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" },
					{ path: "dir", type: "tree", mode: "040000", sha: "sha2" },
					{ path: "file2.txt", type: "blob", mode: "100644", sha: "sha3" }
				];

				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);

				const state = await vault.computeCurrentState();

				expect(state).toEqual({
					"file1.md": "sha1",
					"file2.txt": "sha3"
					// Note: directory is excluded
				});
			});

			it("should handle empty tree", async () => {
				fakeOctokit.setupInitialState("commit123", EMPTY_TREE_SHA, []);

				const state = await vault.computeCurrentState();

				expect(state).toEqual({});
			});

			it("should return all paths without filtering", async () => {
				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" },
					{ path: "_fit/file2.md", type: "blob", mode: "100644", sha: "sha2" },
					{ path: "file3.md", type: "blob", mode: "100644", sha: "sha3" }
				];

				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);

				const state = await vault.computeCurrentState();

				// RemoteGitHubVault returns all paths - caller is responsible for filtering
				expect(state).toEqual({
					"file1.md": "sha1",
					"_fit/file2.md": "sha2",
					"file3.md": "sha3"
				});
			});
		});

		describe("getChanges", () => {
			it("should detect added, modified, and removed files", async () => {
				const baselineState: FileState = {
					"file1.md": "sha1",      // Unchanged
					"file2.md": "sha2-old",  // Modified
					"file3.md": "sha3"       // Removed
				};

				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" },      // Unchanged
					{ path: "file2.md", type: "blob", mode: "100644", sha: "sha2-new" },  // Modified
					{ path: "file4.md", type: "blob", mode: "100644", sha: "sha4" }       // Added
				];

				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);

				const changes = await vault.getChanges(baselineState);

				expect(changes).toEqual(expect.arrayContaining([
					{ path: "file2.md", status: "MODIFIED", currentSha: "sha2-new", extension: "md" },
					{ path: "file3.md", status: "REMOVED", currentSha: undefined, extension: "md" },
					{ path: "file4.md", status: "ADDED", currentSha: "sha4", extension: "md" }
				]));
				expect(changes).toHaveLength(3);
			});

			it("should return empty array when no changes", async () => {
				const baselineState: FileState = {
					"file1.md": "sha1",
					"file2.md": "sha2"
				};

				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" },
					{ path: "file2.md", type: "blob", mode: "100644", sha: "sha2" }
				];

				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);

				const changes = await vault.getChanges(baselineState);

				expect(changes).toEqual([]);
			});
		});

		describe("readFileContent", () => {
			it("should fetch blob content", async () => {
				fakeOctokit.addBlob("sha123", "base64content");

				const content = await vault.readFileContent("sha123");

				expect(content).toBe("base64content");
			});
		});
	});

	describe("Write Operations", () => {
		describe("applyChanges", () => {
			it("should create commit with file additions", async () => {
				fakeOctokit.setupInitialState("parent123", "tree456", []);

				const fileOps = await vault.applyChanges(
					[{ path: "newfile.md", content: "Hello World" }],
					[]
				);

				expect(fileOps).toEqual([
					{ path: "newfile.md", status: "created" }
				]);

				// Verify the file was added to the tree
				const currentTree = fakeOctokit.getCurrentTree();
				expect(currentTree).toEqual(expect.arrayContaining([
					expect.objectContaining({
						path: "newfile.md",
						type: "blob",
						mode: "100644"
					})
				]));
			});

			it("should handle file modifications", async () => {
				const mockTree: TreeNode[] = [
					{ path: "existing.md", type: "blob", mode: "100644", sha: "oldblob" }
				];

				fakeOctokit.setupInitialState("parent123", "tree456", mockTree);

				const fileOps = await vault.applyChanges(
					[{ path: "existing.md", content: "Updated content" }],
					[]
				);

				expect(fileOps).toEqual([
					{ path: "existing.md", status: "changed" }
				]);
			});

			it("should handle file deletions", async () => {
				const mockTree: TreeNode[] = [
					{ path: "todelete.md", type: "blob", mode: "100644", sha: "blob1" }
				];

				fakeOctokit.setupInitialState("parent123", "tree456", mockTree);

				const fileOps = await vault.applyChanges(
					[],
					["todelete.md"]
				);

				expect(fileOps).toEqual([
					{ path: "todelete.md", status: "deleted" }
				]);

				// Verify file was removed from tree
				const currentTree = fakeOctokit.getCurrentTree();
				expect(currentTree?.find(n => n.path === "todelete.md")).toBeUndefined();
			});

			it("should handle binary files with base64 encoding", async () => {
				fakeOctokit.setupInitialState("parent123", "tree456", []);

				const fileOps = await vault.applyChanges(
					[{ path: "image.png", content: "iVBORw0KGgo=" }],
					[]
				);

				expect(fileOps).toEqual([
					{ path: "image.png", status: "created" }
				]);
			});

			it("should skip changes when no tree nodes created", async () => {
				const existingBlobSha = fakeOctokit.hashContent("Same content");
				const mockTree: TreeNode[] = [
					{ path: "file.md", type: "blob", mode: "100644", sha: existingBlobSha }
				];

				fakeOctokit.setupInitialState("parent123", "tree456", mockTree);

				const fileOps = await vault.applyChanges(
					[{ path: "file.md", content: "Same content" }],
					[]
				);

				expect(fileOps).toEqual([]);
				// Commit SHA should not have changed
				expect(fakeOctokit.getLatestCommitSha()).toBe("parent123");
			});

			it("should skip deletion when file doesn't exist on remote", async () => {
				const mockTree: TreeNode[] = [
					{ path: "other.md", type: "blob", mode: "100644", sha: "blob1" }
				];

				fakeOctokit.setupInitialState("parent123", "tree456", mockTree);

				const fileOps = await vault.applyChanges(
					[],
					["nonexistent.md"]
				);

				expect(fileOps).toEqual([]);
			});

			it("should handle mixed operations (add, modify, delete)", async () => {
				const mockTree: TreeNode[] = [
					{ path: "existing.md", type: "blob", mode: "100644", sha: "oldblob" },
					{ path: "todelete.md", type: "blob", mode: "100644", sha: "delblob" }
				];

				fakeOctokit.setupInitialState("parent123", "tree456", mockTree);

				const fileOps = await vault.applyChanges(
					[
						{ path: "new.md", content: "New file" },
						{ path: "existing.md", content: "Updated" }
					],
					["todelete.md"]
				);

				expect(fileOps).toHaveLength(3);
				expect(fileOps).toEqual(expect.arrayContaining([
					{ path: "new.md", status: "created" },
					{ path: "existing.md", status: "changed" },
					{ path: "todelete.md", status: "deleted" }
				]));
			});
		});

		describe("writeFile and deleteFile", () => {
			it("writeFile should delegate to applyChanges", async () => {
				fakeOctokit.setupInitialState("parent123", "tree456", []);

				const result = await vault.writeFile("file.md", "content");

				expect(result).toEqual({ path: "file.md", status: "created" });
			});

			it("deleteFile should delegate to applyChanges", async () => {
				const mockTree: TreeNode[] = [
					{ path: "file.md", type: "blob", mode: "100644", sha: "blob1" }
				];

				fakeOctokit.setupInitialState("parent123", "tree456", mockTree);

				const result = await vault.deleteFile("file.md");

				expect(result).toEqual({ path: "file.md", status: "deleted" });
			});
		});
	});

	describe("Metadata Operations", () => {
		it("should always track all paths (no storage limitations)", () => {
			expect(vault.shouldTrackState("file.md")).toBe(true);
			expect(vault.shouldTrackState(".hidden")).toBe(true);
			expect(vault.shouldTrackState("_fit/file.md")).toBe(true);
			expect(vault.shouldTrackState(".obsidian/config")).toBe(true);
		});

		it("should update and retrieve baseline state", () => {
			const newState: FileState = {
				"file1.md": "sha1",
				"file2.md": "sha2"
			};

			vault.updateBaselineState(newState);
			const retrieved = vault.getBaselineState();

			expect(retrieved).toEqual(newState);
			// Should return a copy, not the same object
			expect(retrieved).not.toBe(newState);
		});
	});
});
