/**
 * Tests for RemoteGitHubVault
 */

import { RemoteGitHubVault, TreeNode } from "./remoteGitHubVault";
import { EMPTY_TREE_SHA } from "./utils";
import { FakeOctokit } from "./testUtils";
import { __setMockOctokitInstance } from "./__mocks__/@octokit/core";
import { FileContent } from "./contentEncoding";

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

	afterEach(() => {
		// Reset mock to prevent test pollution
		__setMockOctokitInstance(null);
	});

	describe("Read Operations", () => {
		describe("readFromSource", () => {
			it("should fetch and update state from non-empty tree", async () => {
				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" },
					{ path: "dir", type: "tree", mode: "040000", sha: "sha2" },
					{ path: "file2.txt", type: "blob", mode: "100644", sha: "sha3" }
				];

				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);

				const result = await vault.readFromSource();

				expect(result).toEqual({
					state: {
						"file1.md": "sha1",
						"file2.txt": "sha3"
						// Note: directory is excluded
					},
					commitSha: "commit123"
				});
			});

			it("should handle empty tree", async () => {
				fakeOctokit.setupInitialState("commit123", EMPTY_TREE_SHA, []);
				// GitHub weirdly returns a 404 error when fetching tree for empty tree SHA.
				// Simulated error is actually skipped and unused if there's no bug.
				const notFoundError: any = new Error("Not found");
				notFoundError.status = 404;
				fakeOctokit.simulateError("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", notFoundError);

				const result = await vault.readFromSource();

				expect(result).toEqual({
					state: {},
					commitSha: "commit123"
				});
			});

			it("should return all paths without filtering", async () => {
				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" },
					{ path: "_fit/file2.md", type: "blob", mode: "100644", sha: "sha2" },
					{ path: "file3.md", type: "blob", mode: "100644", sha: "sha3" }
				];

				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);

				const { state } = await vault.readFromSource();

				// RemoteGitHubVault returns all paths - caller is responsible for filtering
				expect(state).toEqual({
					"file1.md": "sha1",
					"_fit/file2.md": "sha2",
					"file3.md": "sha3"
				});
			});

			it("should propagate errors from getCommitTreeSha", async () => {
				fakeOctokit.setupInitialState("commit123", "tree456", []);

				// Simulate 401 auth error
				const authError: any = new Error("Bad credentials");
				authError.status = 401;
				fakeOctokit.simulateError("GET /repos/{owner}/{repo}/commits/{ref}", authError);

				await expect(vault.readFromSource()).rejects.toThrow("Bad credentials");
			});
		});

		describe("readFileContent", () => {
			it("should fetch blob content by path", async () => {
				// Setup: readFromSource() to populate cache
				const mockTree: TreeNode[] = [
					{ path: "test.md", mode: "100644", type: "blob", sha: "sha123" }
				];
				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);
				fakeOctokit.addBlob("sha123", "base64content");

				// Populate cache
				await vault.readFromSource();

				// Read file content by path
				const content = await vault.readFileContent("test.md");

				expect(content).toEqual(FileContent.fromBase64("base64content"));
			});

			it("should return content only from last FETCHED readFromSource", async () => {
				// Setup: Initial state with file1
				const mockTree1: TreeNode[] = [
					{ path: "file1.md", mode: "100644", type: "blob", sha: "sha1" }
				];
				fakeOctokit.setupInitialState("commit123", "tree456", mockTree1);
				fakeOctokit.addBlob("sha1", "content1");

				// First fetch - populates cache
				await vault.readFromSource();

				// Verify we can read file1
				const content1 = await vault.readFileContent("file1.md");
				expect(content1).toEqual(FileContent.fromBase64("content1"));

				// Simulate remote change - add file2
				const mockTree2: TreeNode[] = [
					{ path: "file1.md", mode: "100644", type: "blob", sha: "sha1" },
					{ path: "file2.md", mode: "100644", type: "blob", sha: "sha2" }
				];
				fakeOctokit.setupInitialState("commit456", "tree789", mockTree2);
				fakeOctokit.addBlob("sha2", "content2");

				// WITHOUT calling readFromSource(), try to read file2
				// Should fail because cache only has file1
				await expect(vault.readFileContent("file2.md")).rejects.toThrow(
					"File 'file2.md' does not exist in remote repository"
				);

				// After fetching, file2 should be available
				await vault.readFromSource();
				const content2 = await vault.readFileContent("file2.md");
				expect(content2).toEqual(FileContent.fromBase64("content2"));
			});
		});

		describe("Caching", () => {
			it("should return from cache when commit SHA hasn't changed", async () => {
				const mockTree: TreeNode[] = [
					{ path: "test.md", mode: "100644", type: "blob", sha: "sha123" }
				];
				fakeOctokit.setupInitialState("commit123", "tree456", mockTree);
				fakeOctokit.addBlob("sha123", "base64content");

				// Read once to populate cache.
				await vault.readFromSource();

				// Second read is from cache.
				fakeOctokit.simulateError("GET /repos/{owner}/{repo}/commits/{ref}",
					new Error("Shouldn't reach here if reading from cache"));
				const result = await vault.readFromSource();

				expect(result).toEqual({
					state: { "test.md": "sha123" },
					commitSha: "commit123"
				});
			});

			it("should fetch latest content when remote tree SHA changed", async () => {
				// Initial state
				const mockTree1: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha1" }
				];
				fakeOctokit.setupInitialState("commit123", "tree456", mockTree1);

				// First read - populates cache
				const result1 = await vault.readFromSource();
				expect(result1).toEqual({
					state: { "file1.md": "sha1" },
					commitSha: "commit123"
				});

				// Simulate remote change - new commit with different tree
				const mockTree2: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: "sha2" },
					{ path: "file2.md", type: "blob", mode: "100644", sha: "sha3" }
				];
				fakeOctokit.setupInitialState("commit456", "tree789", mockTree2);

				// Second read - should refetch because commit SHA changed
				const result2 = await vault.readFromSource();
				expect(result2).toEqual({
					state: {
						"file1.md": "sha2",
						"file2.md": "sha3"
					},
					commitSha: "commit456"
				});
			});
		});
	});

	describe("Write Operations", () => {
		describe("applyChanges", () => {
			it("should create commit with file additions", async () => {
				fakeOctokit.setupInitialState("parent123", "tree456", []);

				const fileOps = await vault.applyChanges(
					[{ path: "newfile.md", content: FileContent.fromPlainText("Hello World") }],
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
					[{ path: "existing.md", content: FileContent.fromPlainText("Updated content") }],
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
					[{ path: "image.png", content: FileContent.fromBase64("iVBORw0KGgo=") }],
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
					[{ path: "file.md", content: FileContent.fromPlainText("Same content") }],
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
						{ path: "new.md", content: FileContent.fromPlainText("New file") },
						{ path: "existing.md", content: FileContent.fromPlainText("Updated") }
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
	});

	describe("Metadata Operations", () => {
		it("should always track all paths (no storage limitations)", () => {
			expect(vault.shouldTrackState("file.md")).toBe(true);
			expect(vault.shouldTrackState(".hidden")).toBe(true);
			expect(vault.shouldTrackState("_fit/file.md")).toBe(true);
			expect(vault.shouldTrackState(".obsidian/config")).toBe(true);
		});
	});

	describe("Error Handling", () => {
		describe("404 errors", () => {
			it("should distinguish between branch not found (repo exists)", async () => {
				// Arrange - repo exists but branch ref doesn't
				fakeOctokit.setRepoExists(true);
				// Don't set up any refs - getRef will fail with 404

				// Act & Assert
				await expect(vault.readFromSource()).rejects.toThrow(
					"Branch 'main' not found on repository 'testowner/testrepo'"
				);
			});

			it("should detect repository not found", async () => {
				// Arrange - repo doesn't exist
				fakeOctokit.setRepoExists(false);

				// Act & Assert
				await expect(vault.readFromSource()).rejects.toThrow(
					"Repository 'testowner/testrepo' not found"
				);
			});

			it("should fall back to generic message if checkRepoExists fails", async () => {
				// Arrange - getRef fails with 404, checkRepoExists also fails (e.g., 403)
				fakeOctokit.setRepoExists(true);
				const accessError: any = new Error("Access denied");
				accessError.status = 403;
				fakeOctokit.simulateError("GET /repos/{owner}/{repo}", accessError);

				// Act & Assert
				await expect(vault.readFromSource()).rejects.toThrow(
					"Repository 'testowner/testrepo' or branch 'main' not found"
				);
			});
		});
	});
});
