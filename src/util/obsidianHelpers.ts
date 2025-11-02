import { base64ToArrayBuffer, arrayBufferToBase64, TFile, Vault } from "obsidian";
import { Base64Content, Content, FileContent, isBinaryExtension } from "./contentEncoding";

export function contentToArrayBuffer(content: Base64Content): ArrayBuffer {
	return base64ToArrayBuffer(content as string);
}

export function arrayBufferToContent(buffer: ArrayBuffer): Base64Content {
	return Content.asBase64(arrayBufferToBase64(buffer));
}

/**
 * Read file content from Obsidian vault.
 * Uses readBinary for known binary extensions, read for text files.
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

	if (isBinaryExtension(file.extension)) {
		const base64 = arrayBufferToBase64(await vault.readBinary(file));
		return FileContent.fromBase64(base64);
	} else {
		const plainText = await vault.read(file);
		return FileContent.fromPlainText(plainText);
	}
}
