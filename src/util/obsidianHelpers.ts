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

	// For hidden files (not visible via Vault API), use adapter directly
	if (!file) {
		try {
			const base64 = arrayBufferToBase64(await vault.adapter.readBinary(path));
			return FileContent.fromBase64(base64);
		} catch (error) {
			throw new Error(`File not found: ${path}`);
		}
	}

	if (!(file instanceof TFile)) {
		throw new Error(`Path is not a file: ${path}`);
	}

	// Try text first, fall back to binary if Obsidian rejects the format
	try {
		const plainText = await vault.read(file);
		return FileContent.fromPlainText(plainText);
	} catch (textError) {
		// Try binary fallback; if it fails again, throw combined error
		try {
			const base64 = arrayBufferToBase64(await vault.readBinary(file));
			return FileContent.fromBase64(base64);
		} catch (binaryError) {
			const cause ={
				asTextError: textError instanceof Error ? textError.message : String(textError),
				asBinaryError: binaryError instanceof Error ? binaryError.message : String(binaryError),
			};

			const error = new Error(
				`Failed to read file "${path}": text read failed (${cause.asTextError}), binary read also failed (${cause.asBinaryError})`
			) as Error & { cause?: unknown };

			error.cause = cause;
			throw error;
		}
	}
}
