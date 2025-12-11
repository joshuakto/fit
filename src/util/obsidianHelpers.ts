import { base64ToArrayBuffer, arrayBufferToBase64, TFile, Vault } from "obsidian";
import { Base64Content, Content, FileContent } from "./contentEncoding";

export function contentToArrayBuffer(content: Base64Content): ArrayBuffer {
	return base64ToArrayBuffer(content as string);
}

export function arrayBufferToContent(buffer: ArrayBuffer): Base64Content {
	return Content.asBase64(arrayBufferToBase64(buffer));
}

/**
 * Read file content from Obsidian vault.
 *
 * Attempts to read as text first; if Obsidian rejects the format
 * (e.g., file contains invalid UTF-8), falls back to readBinary().
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

	// Try text first, fall back to binary if Obsidian rejects the format
	try {
		const plainText = await vault.read(file);
		return FileContent.fromPlainText(plainText);
	} catch {
		// Obsidian throws when file isn't valid UTF-8 text
		// Example: "The file couldn't be opened because it isn't in the correct format"
		const base64 = arrayBufferToBase64(await vault.readBinary(file));
		return FileContent.fromBase64(base64);
	}
}
