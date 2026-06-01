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
	 * @throws {TypeError} If decoded bytes are not valid UTF-8 (binary data)
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/atob#unicode_strings
	 */
	decodeFromBase64: (base64: string | Base64Content): PlainTextContent => {
		// Decode base64 to bytes, then decode UTF-8
		const binaryString = atob(base64);
		const utf8Bytes = Uint8Array.from(binaryString, char => char.charCodeAt(0));
		// fatal: true prevents silent replacement character corruption
		// Will throw TypeError if bytes aren't valid UTF-8 (e.g., binary data)
		return new TextDecoder('utf-8', { fatal: true }).decode(utf8Bytes) as PlainTextContent;
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
	// Raw bytes are the canonical representation. When constructed from
	// ArrayBuffer (the common read path), bytes are stored here immediately
	// and base64/plaintext strings are derived lazily and cached. When
	// constructed from a string, bytes are decoded lazily on first toBytes().
	private rawBytes: Uint8Array | null;
	private base64Cache: Base64Content | null = null;

	private constructor(content: FileContentType, rawBytes: Uint8Array | null) {
		this.content = content;
		this.rawBytes = rawBytes;
	}

	/**
	 * Create a FileContent from raw bytes with an encoding hint.
	 * This is the preferred constructor for local file reads — bytes are stored
	 * directly so SHA computation never needs to re-encode or re-decode.
	 */
	static fromArrayBuffer(buffer: ArrayBuffer, encoding: 'plaintext' | 'base64'): FileContent {
		const bytes = new Uint8Array(buffer);
		// String form is derived lazily on first toBase64()/toPlainText() call
		const placeholder = encoding === 'plaintext'
			? { encoding: 'plaintext' as const, content: '' as PlainTextContent }
			: { encoding: 'base64' as const, content: '' as Base64Content };
		return new FileContent(placeholder, bytes);
	}

	/**
	 * Create a FileContent from a plain text string
	 * Accepts raw strings or already-branded PlainTextContent
	 *
	 * @param content - Plain text string (will be branded as PlainTextContent)
	 */
	static fromPlainText(content: string | PlainTextContent): FileContent {
		return new FileContent({ encoding: 'plaintext', content: Content.asPlainText(content) }, null);
	}

	/**
	 * Create a FileContent from a base64-encoded string
	 * Accepts raw strings or already-branded Base64Content
	 *
	 * @param content - Base64-encoded string (will be branded as Base64Content)
	 */
	static fromBase64(content: string | Base64Content): FileContent {
		if (typeof content !== 'string') {
			throw new TypeError(`FileContent.fromBase64: expected a string but got ${typeof content}`);
		}
		const normalized = Content.asBase64(removeLineEndingsFromBase64String(content));
		return new FileContent({ encoding: 'base64', content: normalized }, null);
	}

	/**
	 * Get raw bytes. For files read from disk this is zero-copy.
	 * For string-constructed instances the bytes are decoded/encoded once and cached.
	 */
	toBytes(): Uint8Array {
		if (this.rawBytes !== null) {
			return this.rawBytes;
		}
		const { encoding, content } = this.content;
		if (encoding === 'plaintext') {
			// fromPlainText path: encode string to UTF-8 bytes
			this.rawBytes = new TextEncoder().encode(content);
		} else {
			// fromBase64 path: decode base64 string to bytes
			const binStr = atob(content);
			const bytes = new Uint8Array(binStr.length);
			for (let i = 0; i < binStr.length; i++) {
				bytes[i] = binStr.charCodeAt(i);
			}
			this.rawBytes = bytes;
		}
		return this.rawBytes;
	}

	/**
	 * Get content as Base64Content, converting if needed. Result is cached.
	 */
	toBase64(): Base64Content {
		if (this.base64Cache !== null) {
			return this.base64Cache;
		}
		const { encoding, content } = this.content;
		let result: Base64Content;
		if (encoding === 'base64' && content !== '') {
			result = content;
		} else if (encoding === 'plaintext' && content !== '') {
			result = Content.encodeToBase64(content);
		} else {
			// constructed from ArrayBuffer — derive from rawBytes
			const bytes = this.toBytes();
			result = Content.asBase64(arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
		}
		this.base64Cache = result;
		return result;
	}

	/**
	 * Get content as PlainTextContent, converting if needed
	 * WARNING: Will fail for binary data that isn't valid UTF-8
	 */
	toPlainText(): PlainTextContent {
		const { encoding, content } = this.content;
		if (encoding === 'plaintext' && content !== '') {
			return content;
		}
		if (encoding === 'plaintext' && this.rawBytes !== null) {
			// constructed from ArrayBuffer with plaintext hint
			const text = new TextDecoder('utf-8', { fatal: true }).decode(this.rawBytes);
			// cache it back
			this.content = { encoding: 'plaintext', content: Content.asPlainText(text) };
			return this.content.content as PlainTextContent;
		}
		return Content.decodeFromBase64(this.toBase64());
	}

	equals(other: FileContent): boolean {
		// Fast path: same encoding, both have string content already
		if (this.content.encoding === other.content.encoding &&
			this.content.content !== '' && other.content.content !== '') {
			return this.content.content === other.content.content;
		}
		// Normalize to base64 for comparison (native string equality, avoids O(n) JS loop)
		return this.toBase64() === other.toBase64();
	}

	toRaw(): FileContentType {
		// If we have a string already, return it directly
		const { encoding, content } = this.content;
		if (encoding === 'plaintext' && content !== '') return this.content;
		if (encoding === 'base64' && content !== '') return this.content;
		// Derive from rawBytes
		if (encoding === 'plaintext') {
			const text = this.toPlainText();
			return { encoding: 'plaintext', content: text };
		}
		return { encoding: 'base64', content: this.toBase64() };
	}

	/**
	 * Get the size of the content in bytes.
	 */
	size(): number {
		if (this.rawBytes !== null) {
			return this.rawBytes.length;
		}
		const { encoding, content } = this.content;
		if (encoding === 'plaintext') {
			// Plain text: string length == byte count for ASCII; may undercount multibyte chars,
			// but callers use this for rough sizing (e.g. 422 threshold checks), not exact math.
			return content.length;
		}
		// Base64: approximate (exact would require decoding). 4 chars → 3 bytes.
		return Math.floor((content.length * 3) / 4);
	}
}

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
