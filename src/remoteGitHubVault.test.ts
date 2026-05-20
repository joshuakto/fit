/**
 * Tests for RemoteGitHubVault
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteGitHubVault, TreeNode } from "./remoteGitHubVault";
import { BlobSha, CommitSha, EMPTY_TREE_SHA, TreeSha } from "./util/hashing";
import { FakeOctokit } from "./testUtils";
import { __setMockOctokitInstance } from "./__mocks__/@octokit/core";
import { FileContent } from "./util/contentEncoding";
import { fitLogger } from "./logger";
import { init as initEncryption } from "./encryption";
import * as Encryption from "./encryption";

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
		// Suppress logging to reduce test noise
		vi.spyOn(fitLogger, 'log').mockImplementation(() => {});
		initEncryption({ settings: { encryptionPassword: '' } } as any);

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
		__setMockOctokitInstance(null);
		vi.restoreAllMocks();
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
					commitSha: COMMIT123_SHA,
					treeSha: TREE456_SHA
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
					commitSha: COMMIT123_SHA,
					treeSha: EMPTY_TREE_SHA
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

			it("should not wrap missing-global errors as network errors", async () => {
				// Simulates a mobile runtime where an assumed global (e.g. Buffer, TextEncoder)
				// is missing — the resulting ReferenceError should propagate as-is rather than
				// being swallowed and misreported as a network failure.
				const mockTree: TreeNode[] = [
					{ path: "file1.md", type: "blob", mode: "100644", sha: BLOB1_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree);
				vi.spyOn(Encryption, 'isEnabled').mockImplementation(() => {
					throw new ReferenceError('Encryption is not defined');
				});

				await expect(vault.readFromSource()).rejects.toBeInstanceOf(ReferenceError);
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

			it("should give a clear error when blob content is missing, including the encoding the API reported", async () => {
				const mockTree: TreeNode[] = [
					{ path: "huge-file.bin", mode: "100644", type: "blob", sha: BLOB1_SHA }
				];
				fakeOctokit.setupInitialState(COMMIT123_SHA, TREE456_SHA, mockTree);
				await vault.readFromSource();

				// Simulate a blob response with no content field — e.g. encoding 'none'
				// returned by GitHub for unsupported blobs. We don't know the exact cause;
				// we just want the error to surface the encoding the API reported rather
				// than crashing with a meaningless TypeError.
				vi.spyOn(fakeOctokit, 'request').mockResolvedValueOnce({
					data: { encoding: 'none', sha: BLOB1_SHA, size: 150_000_000 }
				} as any);

				await expect(vault.readFileContent("huge-file.bin"))
					.rejects.toThrow(/huge-file\.bin.*none|none.*huge-file\.bin/);
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

				// Second read uses cache (only calls commits API to check for changes, not tree API)
				fakeOctokit.simulateError("GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
					new Error("Shouldn't reach here if reading from cache"));
				const result = await vault.readFromSource();

				expect(result).toEqual({
					state: { "test.md": BLOB123_SHA },
					commitSha: COMMIT123_SHA,
					treeSha: TREE456_SHA
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
					commitSha: COMMIT123_SHA,
					treeSha: TREE456_SHA
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
					commitSha: COMMIT456_SHA,
					treeSha: "tree789",
				});
			});
		});
	});

	describe("Write Operations", () => {
		describe("applyChanges", () => {
			it("should create commit with file additions", async () => {
				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, []);

				const result = await vault.applyChanges(
					[{ path: "newfile.md", content: FileContent.fromPlainText("Hello World") }],
					[]
				);

				expect(result).toEqual({
					changes: [{ path: "newfile.md", type: "ADDED" }],
					commitSha: expect.not.stringMatching(PARENTCOMMIT123_SHA),
					treeSha: expect.not.stringMatching(TREE456_SHA),
					newState: { 'newfile.md': expect.any(String) }
				});

				// Verify the file was ADDED to the tree
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

				const result = await vault.applyChanges(
					[{ path: "existing.md", content: FileContent.fromPlainText("Updated content") }],
					[]
				);

				expect(result).toEqual({
					changes: [{ path: "existing.md", type: "MODIFIED" }],
					commitSha: expect.not.stringMatching(PARENTCOMMIT123_SHA),
					treeSha: expect.not.stringMatching(TREE456_SHA),
					newState: { "existing.md": expect.any(String) },
				});
			});

			it("should handle file deletions", async () => {
				const mockTree: TreeNode[] = [
					{ path: "todelete.md", type: "blob", mode: "100644", sha: BLOB1_SHA }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

				const result = await vault.applyChanges(
					[],
					["todelete.md"]
				);

				expect(result).toEqual({
					changes: [{ path: "todelete.md", type: "REMOVED" }],
					commitSha: expect.not.stringMatching(PARENTCOMMIT123_SHA),
					treeSha: expect.not.stringMatching(TREE456_SHA),
					newState: {},
				});

				// Verify file was REMOVED from tree
				const currentTree = fakeOctokit.getCurrentTree();
				expect(currentTree?.find(n => n.path === "todelete.md")).toBeUndefined();
			});

			it("should handle binary files with base64 encoding", async () => {
				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, []);

				const result = await vault.applyChanges(
					[{ path: "image.png", content: FileContent.fromBase64("iVBORw0KGgo=") }],
					[]
				);

				expect(result).toEqual({
					changes: [{ path: "image.png", type: "ADDED" }],
					commitSha: expect.not.stringMatching(PARENTCOMMIT123_SHA),
					treeSha: expect.not.stringMatching(TREE456_SHA),
					newState: { "image.png": expect.any(String) },
				});
			});

			it("should skip changes when no tree nodes created", async () => {
				const existingBlobSha = fakeOctokit.hashContent("Same content") as BlobSha;
				const mockTree: TreeNode[] = [
					{ path: "file.md", type: "blob", mode: "100644", sha: existingBlobSha }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

				const result = await vault.applyChanges(
					[{ path: "file.md", content: FileContent.fromPlainText("Same content") }],
					[]
				);

				expect(result).toEqual({
					changes: [],
					commitSha: PARENTCOMMIT123_SHA, // Unchanged when no tree nodes created
					treeSha: TREE456_SHA, // Unchanged when no tree nodes created
					newState: { "file.md": expect.any(String) },
				});
				// Commit SHA should not have changed
				expect(fakeOctokit.getLatestCommitSha()).toBe(PARENTCOMMIT123_SHA);
			});

			it("should skip deletion when file doesn't exist on remote", async () => {
				const mockTree: TreeNode[] = [
					{ path: "other.md", type: "blob", mode: "100644", sha: BLOB1_SHA }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

				const result = await vault.applyChanges(
					[],
					["nonexistent.md"]
				);

				expect(result).toEqual({
					changes: [],
					commitSha: PARENTCOMMIT123_SHA, // Unchanged when no changes
					treeSha: TREE456_SHA, // Unchanged when no changes
					newState: { "other.md": BLOB1_SHA },
				});
			});

			it("should handle mixed operations (add, modify, delete)", async () => {
				const mockTree: TreeNode[] = [
					{ path: "existing.md", type: "blob", mode: "100644", sha: "oldblob" as BlobSha },
					{ path: "todelete.md", type: "blob", mode: "100644", sha: "delblob" as BlobSha }
				];

				fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, mockTree);

				const result = await vault.applyChanges(
					[
						{ path: "new.md", content: FileContent.fromPlainText("New file") },
						{ path: "existing.md", content: FileContent.fromPlainText("Updated") }
					],
					["todelete.md"]
				);

				expect(result).toEqual({
					changes: expect.arrayContaining([
						{ path: "new.md", type: "ADDED" },
						{ path: "existing.md", type: "MODIFIED" },
						{ path: "todelete.md", type: "REMOVED" }
					]),
					commitSha: expect.anything(),
					treeSha: expect.anything(),
					newState: {
						"new.md": expect.any(String),
						"existing.md": expect.any(String),
					},
				});
			});

			describe("422 size-limit partial skip", () => {
				function make422Error(): Error {
					// Must include response: {} so wrapOctokitError treats it as an HTTP error
					// and re-throws as-is, preserving status === 422.
					const err: any = new Error("input file size too large to process");
					err.status = 422;
					err.response = {};
					return err;
				}

				it("should skip a single file that returns 422, returning skippedPaths and skippedWarning", async () => {
					fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, []);
					fakeOctokit.simulateError("POST /repos/{owner}/{repo}/git/blobs", make422Error());

					const result = await vault.applyChanges(
						[{ path: "huge.mp4", content: FileContent.fromPlainText("x".repeat(100)) }],
						[]
					);

					expect(result.changes).toEqual([]);
					expect(result.skippedPaths).toEqual(["huge.mp4"]);
					expect(result.skippedWarning).toContain("huge.mp4");
					expect(result.skippedWarning).toContain(".gitignore");
					expect(result.skippedWarning).toContain("git push");
					// Commit and tree should be unchanged (no-op)
					expect(result.commitSha).toBe(PARENTCOMMIT123_SHA);
					expect(result.treeSha).toBe(TREE456_SHA);
				});

				it("should skip only the 422 file and commit the rest when uploading multiple files", async () => {
					fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, []);
					// First blob creation (huge.mp4) will fail; second (small.md) will succeed
					fakeOctokit.simulateError("POST /repos/{owner}/{repo}/git/blobs", make422Error());

					const result = await vault.applyChanges(
						[
							{ path: "huge.mp4", content: FileContent.fromPlainText("x".repeat(100)) },
							{ path: "small.md", content: FileContent.fromPlainText("tiny note") },
						],
						[]
					);

					expect(result.skippedPaths).toEqual(["huge.mp4"]);
					expect(result.changes).toEqual([{ path: "small.md", type: "ADDED" }]);
					expect(result.newState).toEqual({ "small.md": expect.any(String) });
					// A new commit was created for the file that succeeded
					expect(result.commitSha).not.toBe(PARENTCOMMIT123_SHA);
				});

				it("should skip all upload files and still apply deletions when all uploads return 422", async () => {
					const existingTree: TreeNode[] = [
						{ path: "todelete.md", type: "blob", mode: "100644", sha: BLOB1_SHA }
					];
					fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, existingTree);
					fakeOctokit.simulatePersistentError("POST /repos/{owner}/{repo}/git/blobs", make422Error());

					const result = await vault.applyChanges(
						[
							{ path: "huge1.mp4", content: FileContent.fromPlainText("x") },
							{ path: "huge2.mp4", content: FileContent.fromPlainText("y") },
						],
						["todelete.md"]
					);

					fakeOctokit.clearError("POST /repos/{owner}/{repo}/git/blobs");
					expect([...result.skippedPaths!].sort()).toEqual(["huge1.mp4", "huge2.mp4"]);
					// Deletion still committed
					expect(result.changes).toEqual([{ path: "todelete.md", type: "REMOVED" }]);
					expect(result.newState).not.toHaveProperty("todelete.md");
					expect(result.commitSha).not.toBe(PARENTCOMMIT123_SHA);
				});

				it("should throw VaultError for non-422 upload failures (unchanged behaviour)", async () => {
					fakeOctokit.setupInitialState(PARENTCOMMIT123_SHA, TREE456_SHA, []);
					const serverError: any = new Error("Internal server error");
					serverError.status = 500;
					serverError.response = {};
					fakeOctokit.simulateError("POST /repos/{owner}/{repo}/git/blobs", serverError);

					await expect(
						vault.applyChanges(
							[{ path: "file.md", content: FileContent.fromPlainText("content") }],
							[]
						)
					).rejects.toThrow(expect.objectContaining({ name: "VaultError" }));
				});
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
