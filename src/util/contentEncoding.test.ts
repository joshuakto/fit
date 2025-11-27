/**
 * Tests for content encoding utilities
 */

import { describe, it, expect } from 'vitest';
import { Content, FileContent } from './contentEncoding';

describe('Content.encodeToBase64', () => {
	it('should correctly encode ASCII text', () => {
		const result = Content.encodeToBase64('Hello, World!');
		expect(result).toBe('SGVsbG8sIFdvcmxkIQ==');
	});

	it('should correctly encode multi-byte Unicode characters (Chinese)', () => {
		const unicodeString = '你好';
		const result = Content.encodeToBase64(unicodeString);
		// The correct Base64 encoding for the UTF-8 representation of '你好' is '5L2g5aW9'
		expect(result).toBe('5L2g5aW9');
	});

	it('should correctly encode emojis', () => {
		const emojiString = 'Hello ✨🎉';
		const result = Content.encodeToBase64(emojiString);
		// Correct Base64 for UTF-8 encoded "Hello ✨🎉"
		expect(result).toBe('SGVsbG8g4pyo8J+OiQ==');
	});

	it('should correctly encode European characters with accents', () => {
		const europeanText = 'Café, naïve, €50';
		const result = Content.encodeToBase64(europeanText);
		// Correct Base64 for UTF-8 encoded "Café, naïve, €50"
		expect(result).toBe('Q2Fmw6ksIG5hw692ZSwg4oKsNTA=');
	});

	it('should handle empty string', () => {
		const result = Content.encodeToBase64('');
		expect(result).toBe('');
	});

	it('should encode very large Unicode strings without RangeError', () => {
		const longText = 'Large content'.repeat(20000);
		const encoded = Content.encodeToBase64(longText);
		expect(Content.decodeFromBase64(encoded)).toBe(longText);
	});

	it('should produce same output as Node Buffer for ASCII', () => {
		const text = 'Hello, World!';
		const ourResult = Content.encodeToBase64(text);
		// This is what Buffer.from(text, 'utf8').toString('base64') produces
		const bufferResult = 'SGVsbG8sIFdvcmxkIQ==';
		expect(ourResult).toBe(bufferResult);
	});

	it('should produce same output as Node Buffer for Unicode', () => {
		const text = '你好, World! ✨ €50';
		const ourResult = Content.encodeToBase64(text);
		// This is what Buffer.from(text, 'utf8').toString('base64') produces
		const bufferResult = '5L2g5aW9LCBXb3JsZCEg4pyoIOKCrDUw';
		expect(ourResult).toBe(bufferResult);
	});

	it('should handle very large files (multi-MB text)', () => {
		// Simulate a ~2.6MB text file (larger than typical markdown)
		const largeText = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50000);
		const encoded = Content.encodeToBase64(largeText);

		// Verify roundtrip
		expect(Content.decodeFromBase64(encoded)).toBe(largeText);
		// Verify it's actually base64 (should be ~33% larger than original UTF-8)
		expect(encoded.length).toBeGreaterThan(largeText.length);
	});
});

describe('Content.decodeFromBase64', () => {
	it('should correctly decode ASCII text', () => {
		const result = Content.decodeFromBase64('SGVsbG8sIFdvcmxkIQ==');
		expect(result).toBe('Hello, World!');
	});

	it('should correctly decode multi-byte Unicode characters', () => {
		// '5L2g5aW9' is the correct Base64 for UTF-8 "你好"
		const result = Content.decodeFromBase64('5L2g5aW9');
		expect(result).toBe('你好');
	});

	it('should correctly decode emojis', () => {
		// 'SGVsbG8g4pyo8J+OiQ==' is the correct Base64 for UTF-8 "Hello ✨🎉"
		const result = Content.decodeFromBase64('SGVsbG8g4pyo8J+OiQ==');
		expect(result).toBe('Hello ✨🎉');
	});

	it('should correctly decode European characters', () => {
		// 'Q2Fmw6ksIG5hw692ZSwg4oKsNTA=' is the correct Base64 for UTF-8 "Café, naïve, €50"
		const result = Content.decodeFromBase64('Q2Fmw6ksIG5hw692ZSwg4oKsNTA=');
		expect(result).toBe('Café, naïve, €50');
	});

	it('should throw on invalid base64', () => {
		expect(() => Content.decodeFromBase64('not-valid-base64!!!')).toThrow();
	});

	it('should handle empty string', () => {
		const result = Content.decodeFromBase64('');
		expect(result).toBe('');
	});
});

describe('FileContent', () => {
	it('should preserve Unicode content through encode/decode cycle', () => {
		const originalText = '你好, World! ✨ €50';
		const fileContent = FileContent.fromPlainText(originalText);

		// Convert to base64 and back
		const base64 = fileContent.toBase64();
		const recreated = FileContent.fromBase64(base64);

		expect(recreated.toPlainText()).toBe(originalText);
	});

	it('should handle binary-like content as base64', () => {
		const binaryBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
		const fileContent = FileContent.fromBase64(binaryBase64);

		expect(fileContent.toBase64()).toBe(binaryBase64);
	});
});
