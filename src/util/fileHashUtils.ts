/**
 * File hash utilities shared between LocalVault (Obsidian) and NodeLocalVault (CLI).
 * No dependencies on Obsidian or Node.js-specific modules.
 */

import { FileContent } from './contentEncoding';
import { BlobSha, computeSha1 } from './hashing';
import { FilePath } from './filePath';

/**
 * Frozen list of binary file extensions for SHA calculation consistency.
 * See LocalVault.ts for full rationale on why this list is frozen.
 * DO NOT modify this list unless you implement a SHA migration strategy.
 */
const FROZEN_BINARY_EXT_FOR_SHA = new Set(["png", "jpg", "jpeg", "pdf"]);

function isBinaryExtensionForSha(extension: string): boolean {
	const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
	return FROZEN_BINARY_EXT_FOR_SHA.has(normalized.toLowerCase());
}

/**
 * Compute SHA-1 hash of file path + content (matches FIT's local SHA format).
 *
 * Path is normalized to NFC before hashing to prevent duplication issues
 * with Unicode normalization (issue #51).
 *
 * NOTE: This is FIT's custom local SHA (not Git's blob SHA). The two cannot be compared.
 */
export async function computeFileSha1(path: string, fileContent: FileContent): Promise<BlobSha> {
	const normalizedPath = FilePath.create(path);
	const extension = FilePath.getExtension(normalizedPath);

	let contentToHash: string;
	if (extension && isBinaryExtensionForSha(extension)) {
		contentToHash = fileContent.toBase64();
	} else {
		try {
			contentToHash = fileContent.toPlainText();
		} catch {
			contentToHash = fileContent.toBase64();
		}
	}
	return computeSha1(normalizedPath + contentToHash) as Promise<BlobSha>;
}
