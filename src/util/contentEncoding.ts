/**
 * Content Encoding Types
 *
 * Provides branded types for compile-time safety when handling encoded vs plain text content.
 * Prevents accidentally mixing base64-encoded and plain text strings.
 */

import { arrayBufferToBase64 } from "obsidian";

/**
 * Plain text content (UTF-8 string)
 * Used for text files like .md, .txt when read from local vault
 */
export type PlainTextContent = string & { readonly __brand: 'PlainText' };

/**
 * Base64-encoded content
 * Used for:
 * - ALL files from GitHub API (returns everything as base64)
 * - Binary files from local vault
 */
export type Base64Content = string & { readonly __brand: 'Base64' };

/**
 * File content with runtime encoding tag
 * This is the primary type for passing file content around - it tracks whether
 * the content is plaintext or base64 at runtime, eliminating the need for callers
 * to check file extensions or guess the encoding.
 */
export type FileContentType =
	| { encoding: 'plaintext', content: PlainTextContent }
	| { encoding: 'base64', content: Base64Content };

/**
 * Utility functions for branding raw strings as typed content
 *
 * Usage:
 *   const plain = Content.asPlainText("Hello");
 *   const base64 = Content.asBase64("SGVsbG8=");
 */
export const Content = {
	/**
	 * Brand a plain string as PlainTextContent
	 * Use when you know a string contains plain UTF-8 text
	 */
	asPlainText: (content: string): PlainTextContent => {
		return content as PlainTextContent;
	},

	/**
	 * Brand a plain string as Base64Content
	 * Use when you know a string is base64-encoded
	 */
	asBase64: (content: string): Base64Content => {
		return content as Base64Content;
	},

	/**
	 * Convert PlainTextContent to Base64Content
	 * Handles multi-byte UTF-8 characters (emojis, Chinese, etc.)
	 *
	 * Uses Obsidian's arrayBufferToBase64 for cross-platform compatibility:
	 * - Works on desktop (Electron) and mobile (iOS/Android)
	 * - Avoids Node.js Buffer API which isn't available on mobile
	 * - Handles large strings without spread operator (no call stack issues)
	 *
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder
	 */
	encodeToBase64: (plainText: string | PlainTextContent): Base64Content => {
		// Convert UTF-8 string to bytes using TextEncoder (cross-platform Web API)
		const utf8Bytes = new TextEncoder().encode(plainText);
		// Extract only the view's bytes, not the entire underlying buffer.
		// While TextEncoder.encode() typically returns a view covering the full buffer,
		// this is not guaranteed - the engine might use buffer pooling or return a slice.
		// Using .buffer directly could include garbage data beyond byteOffset+byteLength.
		const buffer = utf8Bytes.buffer.slice(
			utf8Bytes.byteOffset,
			utf8Bytes.byteOffset + utf8Bytes.byteLength
		);
		// Use Obsidian's base64 encoder (works on all platforms)
		return Content.asBase64(arrayBufferToBase64(buffer));
	},

	/**
	 * Convert Base64Content to PlainTextContent
	 * Handles multi-byte UTF-8 characters (emojis, Chinese, etc.)
	 * @throws {DOMException} If content is not valid base64
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/atob#unicode_strings
	 */
	decodeFromBase64: (base64: string | Base64Content): PlainTextContent => {
		// Decode base64 to bytes, then decode UTF-8
		const binaryString = atob(base64);
		const utf8Bytes = Uint8Array.from(binaryString, char => char.charCodeAt(0));
		return new TextDecoder().decode(utf8Bytes) as PlainTextContent;
	},
};

/**
 * Runtime-tagged file content.
 *
 * Usage:
 *   // Creating FileContent from raw strings:
 *   const plainContent = FileContent.fromPlainText("Hello");
 *   const base64Content = FileContent.fromBase64("SGVsbG8=");
 *
 *   // Reading from vaults:
 *   const content = vault.readFileContent(path);        // Returns FileContent
 *
 *   // Converting to desired format:
 *   const asBase64 = content.toBase64();
 *   const asPlain = content.toPlainText();
 */
export class FileContent {
	private content: FileContentType;

	constructor(content: FileContentType) {
		this.content = content;
	}

	/**
	 * Create a FileContent from a plain text string
	 * Accepts raw strings or already-branded PlainTextContent
	 *
	 * @param content - Plain text string (will be branded as PlainTextContent)
	 */
	static fromPlainText(content: string | PlainTextContent): FileContent {
		return new FileContent({ encoding: 'plaintext', content: Content.asPlainText(content) });
	}

	/**
	 * Create a FileContent from a base64-encoded string
	 * Accepts raw strings or already-branded Base64Content
	 *
	 * @param content - Base64-encoded string (will be branded as Base64Content)
	 */
	static fromBase64(content: string | Base64Content): FileContent {
		const normalized = removeLineEndingsFromBase64String(content);
		return new FileContent({ encoding: 'base64', content: Content.asBase64(normalized) });
	}

	/**
	 * Get content as Base64Content, converting if needed
	 */
	toBase64(): Base64Content {
		const { encoding, content } = this.content;
		if (encoding === 'base64') {
			return content;
		}
		return Content.encodeToBase64(content);
	}

	/**
	 * Get content as PlainTextContent, converting if needed
	 * WARNING: Will fail for binary data that isn't valid UTF-8
	 */
	toPlainText(): PlainTextContent {
		const { encoding, content } = this.content;
		if (encoding === 'plaintext') {
			return content;
		}
		return Content.decodeFromBase64(content);
	}

	toRaw(): FileContentType {
		return this.content;
	}
}

/**
 * Check if a file extension indicates binary content.
 * Binary files are treated as opaque (no diffs, special conflict handling).
 *
 * @param extension - File extension WITHOUT leading dot (e.g., "png", "pdf", not ".png")
 *                    Leading dots are automatically stripped if present.
 */
export function isBinaryExtension(extension: string): boolean {
	const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
	return RECOGNIZED_BINARY_EXT.has(normalized.toLowerCase());
}

/**
 * File extensions that should be treated as binary/opaque content.
 * Used for:
 * 1. Reading files correctly from Obsidian (prefer readBinary for these)
 * 2. User-facing decisions (don't show diffs, treat conflicts as opaque)
 *
 * CURRENT LIMITATIONS:
 * - Small hardcoded list means unknown binary types (.zip, .sqlite, .webp, etc.)
 *   are mishandled as text, which can cause corruption
 * - Extension-based detection is inherently limited (files without extensions,
 *   misnamed files, etc.)
 *
 * TODO: Implement content-based binary detection instead of extension guessing:
 * 1. Technical reading (Obsidian API):
 *    - Try vault.read() first, catch UTF-8 decode errors
 *    - Fall back to vault.readBinary() if decode fails
 *    - Or always use readBinary() and decode as UTF-8, checking for invalid sequences
 * 2. Semantic binary detection (user-facing):
 *    - Detect actual binary content (null bytes, high ratio of non-printable chars)
 *    - Use for conflict resolution UI (show diffs vs "binary file changed")
 * 3. Alternative: Use mime-type library for better extension coverage as interim solution
 */
const RECOGNIZED_BINARY_EXT = new Set(["png", "jpg", "jpeg", "pdf"]);

/**
 * Normalize base64 string by removing all whitespace (newlines, spaces, tabs).
 *
 * Different sources may format base64 differently:
 * - GitHub API: Inserts newlines for readability (every ~60-76 chars)
 * - Obsidian arrayBufferToBase64(): No whitespace
 * - Other tools: May include spaces or tabs
 *
 * Removing all whitespace ensures canonical representation and SHA consistency.
 * Valid base64 only contains [A-Za-z0-9+/=], so whitespace is purely formatting.
 *
 * @param content - Base64 string that may contain whitespace
 * @returns Normalized base64 string without any whitespace
 */
function removeLineEndingsFromBase64String(content: string): string {
	return content.replace(/\s/g, '');
}
