import { describe, it, expect } from 'vitest';
import { toAsciiPattern, detectSuspiciousCorrespondence, findSuspiciousCorrespondences } from './pathPattern';

describe('toAsciiPattern', () => {
	it('replaces each non-ASCII run with a single wildcard', () => {
		expect(toAsciiPattern('Küçük.md')).toBe('K*k.md');
		expect(toAsciiPattern('İstanbul.md')).toBe('*stanbul.md');
		expect(toAsciiPattern('Merhaba dünya.md')).toBe('Merhaba d*nya.md');
	});

	it('leaves all-ASCII paths unchanged', () => {
		expect(toAsciiPattern('test.md')).toBe('test.md');
		expect(toAsciiPattern('notes/file.md')).toBe('notes/file.md');
	});

	it('collapses adjacent non-ASCII chars into one wildcard', () => {
		// ü, ç, ü are three separate non-ASCII chars forming one contiguous run
		expect(toAsciiPattern('Küçük.md')).toBe('K*k.md');
	});
});

describe('detectSuspiciousCorrespondence', () => {
	it('matches a Turkish filename against its GBK-corrupted version', () => {
		const result = detectSuspiciousCorrespondence('Küçük.md', 'K眉莽眉k.md');
		expect(result).not.toBeNull();
		expect(result?.pattern).toBe('K*k.md');
	});

	it('returns null for exact matches', () => {
		expect(detectSuspiciousCorrespondence('Küçük.md', 'Küçük.md')).toBeNull();
	});

	it('returns null for paths with different ASCII structure', () => {
		expect(detectSuspiciousCorrespondence('Küçük.md', 'other.md')).toBeNull();
	});

	it('returns null for all-ASCII paths (no wildcards)', () => {
		expect(detectSuspiciousCorrespondence('test.md', 'test.md')).toBeNull();
	});

	// The fix: whitespace/punctuation alone cannot anchor a sandwich
	it('returns null when the only ASCII between wildcards is whitespace — no false positive for Russian files', () => {
		// "Письмо Ивану.md" and "Письмо Марии.md" both map to "* *.md"
		// The space between the two wildcard positions must not count as a sandwich
		expect(detectSuspiciousCorrespondence('Письмо Ивану.md', 'Письмо Марии.md')).toBeNull();
	});

	it('returns null when non-ASCII leads with no alphanumeric before the wildcard', () => {
		// Pattern "*.md" — no alphanumeric before the wildcard
		expect(detectSuspiciousCorrespondence('あ.md', 'い.md')).toBeNull();
	});

	it('matches when alphanumeric appears on both sides of a wildcard', () => {
		// "file ş.md" vs "file 艧.md" → "file *.md" — "e" before *, "m" after *
		const result = detectSuspiciousCorrespondence('file ş.md', 'file 艧.md');
		expect(result).not.toBeNull();
		expect(result?.pattern).toBe('file *.md');
	});
});

describe('findSuspiciousCorrespondences', () => {
	it('finds a corrupted match in a list of paths', () => {
		const existing = ['notes.md', 'Küçük.md', 'other.md'];
		const results = findSuspiciousCorrespondences('K眉莽眉k.md', existing);
		expect(results).toHaveLength(1);
		expect(results[0].existing).toBe('Küçük.md');
	});

	it('returns empty array when no suspicious correspondences exist', () => {
		const existing = ['notes.md', 'other.md'];
		expect(findSuspiciousCorrespondences('Письмо.md', existing)).toHaveLength(0);
	});

	it('does not flag Russian files against each other', () => {
		const existing = ['Письмо Ивану.md'];
		expect(findSuspiciousCorrespondences('Письмо Марии.md', existing)).toHaveLength(0);
	});
});
