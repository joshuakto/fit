import { base64ToArrayBuffer, arrayBufferToBase64, TFile, Vault } from "obsidian";
import { Base64Content, Content, FileContent } from "./contentEncoding";

export function contentToArrayBuffer(content: Base64Content): ArrayBuffer {
	return base64ToArrayBuffer(content as string);
}

export function arrayBufferToContent(buffer: ArrayBuffer): Base64Content {
	return Content.asBase64(arrayBufferToBase64(buffer));
}

/**
 * Decode ArrayBuffer to FileContent with binary detection.
 *
 * Strategy:
 * 1. Check first ~8KB for null bytes (Git's binary detection heuristic)
 * 2. Try UTF-8 decoding with fatal:true
 *    - Success: return as plaintext
 *    - Throws: return as base64 (binary file)
 *
 * The fatal:true flag efficiently detects binary content by throwing on
 * null bytes (0x00) or invalid UTF-8 sequences.
 *
 * @param arrayBuffer - Raw file bytes
 * @returns FileContent with appropriate encoding
 */
export function decodeFileContent(arrayBuffer: ArrayBuffer): FileContent {
	// Check first ~8KB for null bytes (0x00) - Git's proven binary detection heuristic
	// Null bytes are valid UTF-8 (U+0000) but reliably indicate binary files
	const bytes = new Uint8Array(arrayBuffer.slice(0, Math.min(8192, arrayBuffer.byteLength)));
	const hasNullByte = bytes.some(b => b === 0);

	if (hasNullByte) {
		// Binary file - return as base64
		const base64 = arrayBufferToBase64(arrayBuffer);
		return FileContent.fromBase64(base64);
	}

	// No null bytes - try UTF-8 decode with fatal:true (throws on invalid UTF-8)
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
		return FileContent.fromPlainText(text);
	} catch {
		// Invalid UTF-8 (binary file) - return as base64
		const base64 = arrayBufferToBase64(arrayBuffer);
		return FileContent.fromBase64(base64);
	}
}

/**
 * Read file content from Obsidian vault with binary detection.
 *
 * Prevents corruption from vault.read() succeeding on binary files (issue #156).
 *
 * @param vault - Obsidian Vault instance
 * @param path - Path to the file to read
 * @returns FileContent with appropriate encoding
 */
export async function readFileContent(
	vault: Vault,
	path: string
): Promise<FileContent> {
	// Try indexed read first (faster if file is in vault index)
	// Note: getAbstractFileByPath() returns null for hidden files even when they exist
	// See docs/api-compatibility.md "Reading Untracked Files"
	const file = vault.getAbstractFileByPath(path);

	let arrayBuffer: ArrayBuffer;

	if (file) {
		// File found in vault index
		if (!(file instanceof TFile)) {
			throw new Error(`Path is not a file: ${path}`);
		}
		// Read raw bytes (reliable on all platforms, unlike vault.read())
		arrayBuffer = await vault.readBinary(file);
	} else {
		// File not in index - try reading directly from adapter
		// This handles hidden files that Obsidian doesn't track
		try {
			arrayBuffer = await vault.adapter.readBinary(path);
		} catch (error) {
			// Adapter read failed - could be missing file, permissions, I/O error, etc.
			// Re-throw with context but preserve original error message
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to read ${path}: ${message}`);
		}
	}

	// Decode the content (same path for both indexed and unindexed files)
	return decodeFileContent(arrayBuffer);
}
