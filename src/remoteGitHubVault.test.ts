/**
 * Tests for RemoteGitHubVault
 */

import { RemoteGitHubVault, TreeNode } from "./remoteGitHubVault";
import { BlobSha, CommitSha, EMPTY_TREE_SHA, TreeSha } from "./util/hashing";
import { FakeOctokit } from "./testUtils";
import { __setMockOctokitInstance } from "./__mocks__/@octokit/core";
import { FileContent } from "./util/contentEncoding";

const COMMIT123_SHA = "commit123" as CommitSha;
const COMMIT456_SHA = "commit456" as CommitSha;
const PARENTCOMMIT123_SHA = "parent123" as CommitSha;
const TREE456_SHA = "tree456" as TreeSha;
const BLOB123_SHA = "sha123" as BlobSha;
const BLOB1_SHA = "sha1" as BlobSha;
const BLOB2_SHA = "sha2" as BlobSha;
const BLOB3_SHA = "sha3" as BlobSha;

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
					{ path: "file1.md", type: "blob", mode: "100644", sha: BLOB1_SHA },
					{ path: "dir", type: "tree", mode: "040000", sha: TREE456_SHA },
					{ path: "file2.txt", type: "blob", mode: "100644", sha: BLOB3_SHA }
				];

				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree);

				const result = await vault.readFromSource();

				expect(result).toEqual({
					state: {
						"file1.md": BLOB1_SHA,
						"file2.txt": BLOB3_SHA
						// Note: directory is excluded
					},
					commitSha: COMMIT123_SHA
				});
			});

			it("should handle empty tree", async () => {
				fakeOctokit.setupInitialState(COMMIT123_SHA, EMPTY_TREE_SHA, []);
				// GitHub weirdly returns a 404 error when fetching tree for empty tree SHA.
				// Simulated error is actually skipped and unused if there's no bug.
				const notFoundError: any = new Error("Not found");
				notFoundError.status = 404;
				fakeOctokit.simulateError("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", notFoundError);

				const result = await vault.readFromSource();

				expect(result).toEqual({
					state: {},
					commitSha: COMMIT123_SHA
				});
			});

			it("should return all paths without filtering", async () => {
				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: BLOB1_SHA },
					{ path: "_fit/file2.md", type: "blob", mode: "100644", sha: BLOB2_SHA },
					{ path: "file3.md", type: "blob", mode: "100644", sha: BLOB3_SHA }
				];

				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree);

				const { state } = await vault.readFromSource();

				// RemoteGitHubVault returns all paths - caller is responsible for filtering
				expect(state).toEqual({
					"file1.md": BLOB1_SHA,
					"_fit/file2.md": BLOB2_SHA,
					"file3.md": BLOB3_SHA
				});
			});

			it("should propagate errors from getCommitTreeSha", async () => {
				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, []);

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
					{ path: "test.md", mode: "100644", type: "blob", sha: BLOB123_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree);
				fakeOctokit.addBlob(BLOB123_SHA, "base64content");

				// Populate cache
				await vault.readFromSource();

				// Read file content by path
				const content = await vault.readFileContent("test.md");

				expect(content).toEqual(FileContent.fromBase64("base64content"));
			});

			it("should return content only from last FETCHED readFromSource", async () => {
				// Setup: Initial state with file1
				const mockTree1: TreeNode[] = [
					{ path: "file1.md", mode: "100644", type: "blob", sha: BLOB1_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree1);
				fakeOctokit.addBlob(BLOB1_SHA, "content1");

				// First fetch - populates cache
				await vault.readFromSource();

				// Verify we can read file1
				const content1 = await vault.readFileContent("file1.md");
				expect(content1).toEqual(FileContent.fromBase64("content1"));

				// Simulate remote change - add file2
				const mockTree2: TreeNode[] = [
					{ path: "file1.md", mode: "100644", type: "blob", sha: BLOB1_SHA },
					{ path: "file2.md", mode: "100644", type: "blob", sha: BLOB2_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT456_SHA, "tree789" as TreeSha, mockTree2);
				fakeOctokit.addBlob(BLOB2_SHA, "content2");

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
					{ path: "test.md", mode: "100644", type: "blob", sha: BLOB123_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree);
				fakeOctokit.addBlob(BLOB123_SHA, "base64content");

				// Read once to populate cache.
				await vault.readFromSource();

				// Second read is from cache.
				fakeOctokit.simulateError("GET /repos/{owner}/{repo}/commits/{ref}",
					new Error("Shouldn't reach here if reading from cache"));
				const result = await vault.readFromSource();

				expect(result).toEqual({
					state: { "test.md": BLOB123_SHA },
					commitSha: COMMIT123_SHA
				});
			});

			it("should fetch latest content when remote tree SHA changed", async () => {
				// Initial state
				const mockTree1: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: BLOB1_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree1);

				// First read - populates cache
				const result1 = await vault.readFromSource();
				expect(result1).toEqual({
					state: { "file1.md": BLOB1_SHA },
					commitSha: COMMIT123_SHA
				});

				// Simulate remote change - new commit with different tree
				const mockTree2: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: BLOB2_SHA },
					{ path: "file2.md", type: "blob", mode: "100644", sha: BLOB3_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT456_SHA, "tree789" as TreeSha, mockTree2);

				// Second read - should refetch because commit SHA changed
				const result2 = await vault.readFromSource();
				expect(result2).toEqual({
					state: {
						"file1.md": BLOB2_SHA,
						"file2.md": BLOB3_SHA
					},
					commitSha: COMMIT456_SHA
				});
			});
		});
	});

	describe("Write Operations", () => {
		describe("applyChanges", () => {
			it("should create commit with file additions", async () => {
				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, []);

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
					{ path: "existing.md", type: "blob", mode: "100644", sha: "oldblob" as BlobSha }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

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
					{ path: "todelete.md", type: "blob", mode: "100644", sha: BLOB1_SHA }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

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
				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, []);

				const fileOps = await vault.applyChanges(
					[{ path: "image.png", content: FileContent.fromBase64("iVBORw0KGgo=") }],
					[]
				);

				expect(fileOps).toEqual([
					{ path: "image.png", status: "created" }
				]);
			});

			it("should skip changes when no tree nodes created", async () => {
				const existingBlobSha = fakeOctokit.hashContent("Same content") as BlobSha;
				const mockTree: TreeNode[] = [
					{ path: "file.md", type: "blob", mode: "100644", sha: existingBlobSha }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

				const fileOps = await vault.applyChanges(
					[{ path: "file.md", content: FileContent.fromPlainText("Same content") }],
					[]
				);

				expect(fileOps).toEqual([]);
				// Commit SHA should not have changed
				expect(fakeOctokit.getLatestCommitSha()).toBe(PARENTCOMMIT123_SHA);
			});

			it("should skip deletion when file doesn't exist on remote", async () => {
				const mockTree: TreeNode[] = [
					{ path: "other.md", type: "blob", mode: "100644", sha: BLOB1_SHA }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

				const fileOps = await vault.applyChanges(
					[],
					["nonexistent.md"]
				);

				expect(fileOps).toEqual([]);
			});

			it("should handle mixed operations (add, modify, delete)", async () => {
				const mockTree: TreeNode[] = [
					{ path: "existing.md", type: "blob", mode: "100644", sha: "oldblob" as BlobSha },
					{ path: "todelete.md", type: "blob", mode: "100644", sha: "delblob" as BlobSha }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

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
