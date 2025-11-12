/**
 * Tests for FilePath type-safe path utilities
 */

import { describe, it, expect } from 'vitest';
import { FilePath } from './filePath';

describe('FilePath namespace', () => {
	describe('create', () => {
		it('creates FilePath from raw string', () => {
			const path = FilePath.create('notes/daily.md');
			expect(path).toBe('notes/daily.md');
		});

		it('normalizes to NFC form', () => {
			// Turkish characters in NFD (decomposed) form
			const nfdPath = "Merhaba dünya ıııııııİİİİ.md".normalize('NFD');
			const path = FilePath.create(nfdPath);

			// Should be NFC (composed) form
			const nfcExpected = "Merhaba dünya ıııııııİİİİ.md".normalize('NFC');
			expect(path).toBe(nfcExpected);
			expect(path).not.toBe(nfdPath); // Different from NFD input
		});

		it('handles ASCII paths unchanged', () => {
			const path = FilePath.create('README.md');
			expect(path).toBe('README.md');
		});

		it('handles paths with forward slashes', () => {
			const path = FilePath.create('folder/subfolder/file.md');
			expect(path).toBe('folder/subfolder/file.md');
		});
	});

	describe('getExtension', () => {
		it('extracts extension from simple filename', () => {
			const path = FilePath.create('document.md');
			expect(FilePath.getExtension(path)).toBe('md');
		});

		it('extracts extension from path with directories', () => {
			const path = FilePath.create('notes/daily/2024-01-01.md');
			expect(FilePath.getExtension(path)).toBe('md');
		});

		it('returns null for filename without extension', () => {
			const path = FilePath.create('README');
			expect(FilePath.getExtension(path)).toBeNull();
		});

		it('returns null for hidden files starting with dot (Python pathlib convention)', () => {
			const path = FilePath.create('.gitignore');
			expect(FilePath.getExtension(path)).toBeNull();
		});

		it('returns null for .DS_Store and similar dotfiles', () => {
			expect(FilePath.getExtension(FilePath.create('.DS_Store'))).toBeNull();
			expect(FilePath.getExtension(FilePath.create('.vscode'))).toBeNull();
		});

		it('DOES extract extension from hidden directory files', () => {
			// Files IN hidden directories still have extensions
			const path = FilePath.create('.obsidian/app.json');
			expect(FilePath.getExtension(path)).toBe('json');
		});

		it('handles multiple dots correctly (takes last segment)', () => {
			const path = FilePath.create('archive.tar.gz');
			expect(FilePath.getExtension(path)).toBe('gz');
		});

		it('handles binary extensions', () => {
			const path = FilePath.create('image.png');
			expect(FilePath.getExtension(path)).toBe('png');
		});
	});

	describe('isHidden', () => {
		it('detects files starting with dot', () => {
			expect(FilePath.isHidden(FilePath.create('.gitignore'))).toBe(true);
			expect(FilePath.isHidden(FilePath.create('.DS_Store'))).toBe(true);
		});

		it('detects files in hidden directories', () => {
			expect(FilePath.isHidden(FilePath.create('.obsidian/config.json'))).toBe(true);
			expect(FilePath.isHidden(FilePath.create('.obsidian/plugins/fit/main.js'))).toBe(true);
		});

		it('detects nested hidden directories', () => {
			expect(FilePath.isHidden(FilePath.create('folder/.hidden/file.md'))).toBe(true);
			expect(FilePath.isHidden(FilePath.create('normal/.git/config'))).toBe(true);
		});

		it('returns false for normal files', () => {
			expect(FilePath.isHidden(FilePath.create('README.md'))).toBe(false);
			expect(FilePath.isHidden(FilePath.create('notes/daily/2024-01-01.md'))).toBe(false);
		});

		it('returns false for files with "." in name but not at start', () => {
			expect(FilePath.isHidden(FilePath.create('file.with.dots.md'))).toBe(false);
			expect(FilePath.isHidden(FilePath.create('folder/file.md'))).toBe(false);
		});
	});

	describe('getDebugInfo', () => {
		it('provides debug info for ASCII path', () => {
			const path = FilePath.create('README.md');
			const info = FilePath.getDebugInfo(path);

			expect(info).toEqual({
				path: 'README.md',
				isNfc: true,
				isNfd: true, // ASCII is same in both forms
				hasNonAscii: false,
				charLength: 9,
				byteLength: 9, // ASCII is 1 byte per char
			});
		});

		it('provides debug info for Turkish characters (NFC)', () => {
			const turkishPath = "dünya.md";
			const path = FilePath.create(turkishPath);
			const info = FilePath.getDebugInfo(path);

			expect(info).toMatchObject({
				isNfc: true,
				hasNonAscii: true,
				charLength: 8, // d ü n y a . m d
			});
			expect(info.byteLength).toBeGreaterThan(info.charLength) // Multi-byte UTF-8
		});

		it('shows NFD input was normalized to NFC', () => {
			const nfdPath = "dünya.md".normalize('NFD');
			const path = FilePath.create(nfdPath);
			const info = FilePath.getDebugInfo(path);

			expect(info).toMatchObject({
				isNfc: true,
				isNfd: false, // Was normalized from NFD to NFC
			});
		});
	});

	describe('toRaw', () => {
		it('converts FilePath back to string', () => {
			const path = FilePath.create('notes/daily.md');
			const raw = FilePath.toRaw(path);

			expect(raw).toBe('notes/daily.md');
			expect(typeof raw).toBe('string');
		});
	});

	describe('type safety', () => {
		it('FilePath is assignable to string in runtime', () => {
			const path = FilePath.create('file.md');
			const str: string = path; // Should compile and work at runtime
			expect(str).toBe('file.md');
		});

		it('raw string is not assignable to FilePath without create()', () => {
			// This should fail TypeScript compilation (but we can't test that here)
			// const path: FilePath = 'file.md'; // ❌ TypeScript error
			// const path: FilePath = FilePath.create('file.md'); // ✅ Correct
		});
	});
});

describe('FilePath normalization consistency', () => {
	it('ensures same logical path produces same FilePath regardless of input form', () => {
		const turkishText = "dünya.md";
		const nfcInput = turkishText.normalize('NFC');
		const nfdInput = turkishText.normalize('NFD');

		// Both should normalize to same FilePath
		const pathFromNfc = FilePath.create(nfcInput);
		const pathFromNfd = FilePath.create(nfdInput);

		expect(pathFromNfc).toBe(pathFromNfd);
	});

	it('handles Russian Cyrillic normalization', () => {
		const russianText = "принцип неопределённости.md";
		const nfcInput = russianText.normalize('NFC');
		const nfdInput = russianText.normalize('NFD');

		const pathFromNfc = FilePath.create(nfcInput);
		const pathFromNfd = FilePath.create(nfdInput);

		expect(pathFromNfc).toBe(pathFromNfd);
	});
});
