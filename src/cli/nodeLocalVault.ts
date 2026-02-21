/**
 * Node.js filesystem implementation of ILocalVault.
 *
 * Provides a local vault backed by the Node.js fs module instead of
 * Obsidian's Vault API. Used by the CLI to sync an Obsidian vault
 * directory from the command line without running Obsidian.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ILocalVault, ApplyChangesResult, VaultError, VaultReadResult } from '../vault';
import { FileChange, FileStates } from '../util/changeTracking';
import { FileContent } from '../util/contentEncoding';
import { BlobSha } from '../util/hashing';
import { computeFileSha1 } from '../util/fileHashUtils';
import { detectNormalizationIssues } from '../util/filePath';
import { fitLogger } from '../logger';

/**
 * Converts a Node.js Buffer to a FileContent with automatic binary detection.
 * Uses the same heuristics as Obsidian's LocalVault (null-byte check + UTF-8 decode).
 */
const BINARY_DETECTION_SAMPLE_SIZE = 8192; // 8KB - matches LocalVault heuristic

function bufferToFileContent(buffer: Buffer): FileContent {
	const sample = buffer.subarray(0, Math.min(BINARY_DETECTION_SAMPLE_SIZE, buffer.length));
	const hasNullByte = sample.includes(0);

	if (hasNullByte) {
		return FileContent.fromBase64(buffer.toString('base64'));
	}

	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
		return FileContent.fromPlainText(text);
	} catch {
		return FileContent.fromBase64(buffer.toString('base64'));
	}
}

/**
 * Local vault implementation for CLI (Node.js).
 *
 * Mirrors the behaviour of LocalVault (Obsidian) but uses Node.js fs APIs.
 * Key differences:
 * - Uses forward-slash paths relative to vaultPath (matching Obsidian convention)
 * - Hidden files (dot-prefixed) are excluded from state tracking (same policy)
 * - No Obsidian Vault index: existence is checked via fs.stat
 */
export class NodeLocalVault implements ILocalVault {
	private vaultPath: string;

	constructor(vaultPath: string) {
		this.vaultPath = path.resolve(vaultPath);
	}

	/** Absolute path from a vault-relative path */
	private abs(relPath: string): string {
		return path.join(this.vaultPath, relPath);
	}

	/** Convert OS-specific separator back to forward slash for vault paths */
	private toVaultPath(osPath: string): string {
		return osPath.split(path.sep).join('/');
	}

	shouldTrackState(filePath: string): boolean {
		const parts = filePath.split('/');
		return !parts.some(part => part.startsWith('.'));
	}

	async statPaths(paths: string[]): Promise<Map<string, 'file' | 'folder' | null>> {
		const results = await Promise.all(
			paths.map(async (p) => {
				try {
					const stat = await fs.stat(this.abs(p));
					return [p, stat.isDirectory() ? 'folder' : 'file'] as const;
				} catch {
					return [p, null] as const;
				}
			})
		);
		return new Map(results);
	}

	async readFromSource(): Promise<VaultReadResult<"local">> {
		const allPaths = await this.walkDir('');
		const trackedPaths = allPaths.filter(p => this.shouldTrackState(p));

		const shaResults = await Promise.allSettled(
			trackedPaths.map(async (p): Promise<[string, BlobSha]> => {
				const content = await this.readFileContent(p);
				const sha = await computeFileSha1(p, content);
				return [p, sha];
			})
		);

		const state: FileStates = {};
		for (const result of shaResults) {
			if (result.status === 'fulfilled') {
				const [p, sha] = result.value;
				state[p] = sha;
			}
		}

		const normalizationInfo = detectNormalizationIssues(trackedPaths, 'node filesystem');
		fitLogger.log(
			`... 💾 [NodeLocalVault] Scanned ${Object.keys(state).length} files`,
			normalizationInfo ? { nfdPaths: normalizationInfo.nfdCount } : undefined
		);

		return { state };
	}

	async readFileContent(filePath: string): Promise<FileContent> {
		try {
			const buffer = await fs.readFile(this.abs(filePath));
			return bufferToFileContent(buffer);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw VaultError.filesystem(`Failed to read ${filePath}: ${message}`, { originalError: error });
		}
	}

	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>,
		options?: { clashPaths?: Set<string> }
	): Promise<ApplyChangesResult<"local">> {
		const clashPaths = options?.clashPaths ?? new Set<string>();
		const changes: FileChange[] = [];
		const shaEntries: [string, BlobSha][] = [];

		// Write files
		for (const { path: filePath, content } of filesToWrite) {
			const writePath = clashPaths.has(filePath) ? `_fit/${filePath}` : filePath;
			const shaPath = clashPaths.has(filePath) ? filePath : writePath;

			await this.ensureDirExists(writePath);
			const absPath = this.abs(writePath);

			const raw = content.toRaw();
			let existed: boolean;
			try {
				await fs.access(absPath);
				existed = true;
			} catch {
				existed = false;
			}

			if (raw.encoding === 'plaintext') {
				await fs.writeFile(absPath, raw.content, 'utf-8');
			} else {
				await fs.writeFile(absPath, Buffer.from(raw.content, 'base64'));
			}

			changes.push({ path: writePath, type: existed ? 'MODIFIED' : 'ADDED' });

			// Compute SHA for baseline tracking (using original path, not _fit/ prefixed)
			const sha = await computeFileSha1(shaPath, content);
			shaEntries.push([shaPath, sha]);
		}

		// Delete files
		for (const filePath of filesToDelete) {
			const absPath = this.abs(filePath);
			try {
				await fs.unlink(absPath);
				changes.push({ path: filePath, type: 'REMOVED' });
				await this.removeEmptyDirs(filePath);
			} catch (error) {
				// If file doesn't exist, treat as a no-op (already deleted)
				const err = error as { code?: string };
				if (err.code !== 'ENOENT') {
					const message = error instanceof Error ? error.message : String(error);
					throw VaultError.filesystem(`Failed to delete ${filePath}: ${message}`, { originalError: error });
				}
			}
		}

		const newBaselineStates: FileStates = Object.fromEntries(shaEntries);

		return {
			changes,
			newBaselineStates: Promise.resolve(newBaselineStates)
		};
	}

	/** Recursively walk a directory and return vault-relative file paths */
	private async walkDir(dir: string): Promise<string[]> {
		const results: string[] = [];
		const absDir = dir ? this.abs(dir) : this.vaultPath;

		let entries;
		try {
			entries = await fs.readdir(absDir, { withFileTypes: true });
		} catch {
			return results;
		}

		for (const entry of entries) {
			const relPath = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				const subFiles = await this.walkDir(relPath);
				results.push(...subFiles);
			} else if (entry.isFile()) {
				results.push(relPath);
			}
		}

		return results;
	}

	/** Ensure all parent directories exist for a vault-relative file path */
	private async ensureDirExists(filePath: string): Promise<void> {
		const parts = filePath.split('/');
		if (parts.length <= 1) return;

		const dirPath = parts.slice(0, -1).join('/');
		await fs.mkdir(this.abs(dirPath), { recursive: true });
	}

	/** Remove empty parent directories after a file deletion */
	private async removeEmptyDirs(filePath: string): Promise<void> {
		const parts = filePath.split('/');
		for (let i = parts.length - 1; i > 0; i--) {
			const dirPath = parts.slice(0, i).join('/');
			const absDir = this.abs(dirPath);
			try {
				const entries = await fs.readdir(absDir);
				if (entries.length === 0) {
					await fs.rmdir(absDir);
				} else {
					break; // Non-empty dir - stop climbing
				}
			} catch {
				break;
			}
		}
	}
}
