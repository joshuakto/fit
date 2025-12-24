import { base64ToArrayBuffer, arrayBufferToBase64, TFile, Vault } from "obsidian";
import { Base64Content, Content, FileContent } from "./contentEncoding";

export function contentToArrayBuffer(content: Base64Content): ArrayBuffer {
	return base64ToArrayBuffer(content as string);
}

export function arrayBufferToContent(buffer: ArrayBuffer): Base64Content {
	return Content.asBase64(arrayBufferToBase64(buffer));
}

/**
 * Read file content from Obsidian vault with binary detection.
 *
 * Strategy:
 * 1. Read raw bytes via readBinary() (reliable on all platforms)
 * 2. Try UTF-8 decoding with fatal:true
 *    - Success: return as plaintext
 *    - Throws: return as base64 (binary file)
 *
 * The fatal:true flag efficiently detects binary content in one pass by throwing
 * on null bytes (0x00) or invalid UTF-8 sequences, eliminating need for separate
 * null byte scanning.
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
	const file = vault.getAbstractFileByPath(path);
	if (!file) {
		throw new Error(`File not found: ${path}`);
	}
	if (!(file instanceof TFile)) {
		throw new Error(`Path is not a file: ${path}`);
	}

	// Read raw bytes (reliable on all platforms, unlike vault.read())
	const arrayBuffer = await vault.readBinary(file);

	// Try UTF-8 decode with fatal:true (throws on null bytes or invalid UTF-8)
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
		return FileContent.fromPlainText(text);
	} catch {
		// Invalid UTF-8 (binary file) - return as base64
		const base64 = arrayBufferToBase64(arrayBuffer);
		return FileContent.fromBase64(base64);
	}
}
