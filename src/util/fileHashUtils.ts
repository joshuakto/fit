/**
 * File hash utilities shared between LocalVault (Obsidian) and NodeLocalVault (CLI).
 * No dependencies on Obsidian or Node.js-specific modules.
 */

import { FileContent } from "./contentEncoding";
import { BlobSha, computeSha1 } from "./hashing";
import { FilePath } from "./filePath";

/**
 * Frozen list of binary file extensions for SHA calculation consistency.
 *
 * IMPORTANT: This list is FROZEN to prevent spurious sync operations.
 *
 * Why this matters:
 * - Before: Non-listed binaries (.zip, .exe, etc.) had SHAs computed on
 *   CORRUPTED plaintext (with replacement characters \uFFFD) because toPlainText()
 *   silently corrupted binary data
 * - After: toPlainText() throws on binary, computeFileSha1() catches and uses base64
 * - Problem: Existing .zip files will get DIFFERENT SHAs (corrupted vs correct)
 * - Result: Plugin detects "change" and tries to sync the same file again
 *
 * Solution:
 * - Keep list FROZEN to avoid batch SHA changes for existing users
 * - New fatal:true logic handles unlisted extensions gracefully via try/catch
 * - Users with .zip files will see ONE spurious sync after upgrading (acceptable)
 *
 * Future: Implement SHA migration strategy to expand this list safely
 * (e.g., version stores, detect and re-hash on upgrade, warn users)
 *
 * DO NOT modify this list unless you implement a SHA migration strategy.
 */
const FROZEN_BINARY_EXT_FOR_SHA = new Set(["png", "jpg", "jpeg", "pdf"]);

/**
 * Check if a file extension is considered binary for SHA calculation purposes.
 * Uses FROZEN_BINARY_EXT_FOR_SHA to ensure SHA consistency.
 *
 * @param extension - File extension with or without leading dot (e.g., "png" or ".png")
 */
function isBinaryExtensionForSha(extension: string): boolean {
	const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
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
export async function computeFileSha1(
	path: string,
	fileContent: FileContent,
): Promise<BlobSha> {
	// Normalize path to NFC form for consistent hashing across platforms
	const normalizedPath = FilePath.create(path);
	const extension = FilePath.getExtension(normalizedPath);

	let contentToHash: string;
	if (extension && isBinaryExtensionForSha(extension)) {
		// Use base64 representation for consistent hashing
		contentToHash = fileContent.toBase64();
	} else {
		// Preserve plaintext SHA logic for non-binary case.
		// NOTE: For non-FROZEN extensions like .zip, if content is binary,
		// toPlainText() will now throw (due to fatal:true in decodeFromBase64).
		// We intentionally fall back to base64 to avoid corruption.
		// This may cause SHA changes for existing .zip files, but prevents
		// silent replacement character corruption in SHA computation.
		// TODO(future): Implement SHA migration strategy to expand FROZEN_BINARY_EXT_FOR_SHA
		// to include all common binary extensions (.zip, .exe, .bin, etc.)
		try {
			contentToHash = fileContent.toPlainText();
		} catch {
			// Binary content detected (invalid UTF-8) - fall back to base64
			contentToHash = fileContent.toBase64();
		}
	}
	return computeSha1(normalizedPath + contentToHash) as Promise<BlobSha>;
}
