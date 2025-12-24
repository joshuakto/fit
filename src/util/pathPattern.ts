/**
 * Path pattern matching utilities for detecting encoding corruption.
 *
 * Issue #51: UTF-8 bytes misread as GBK can create paths where non-ASCII
 * characters are corrupted but ASCII characters remain intact.
 * Example: "Küçük.md" → "K眉莽眉k.md"
 *
 * These utilities detect such correspondences by comparing ASCII-sandwich patterns.
 */

/**
 * Replace each contiguous run of non-ASCII characters with a wildcard "*".
 *
 * Examples:
 * - "Küçük.md" → "K*k.md"
 * - "İstanbul.md" → "*stanbul.md"
 * - "Merhaba dünya.md" → "Merhaba d*nya.md"
 * - "test.md" → "test.md" (no non-ASCII, no wildcards)
 *
 * @param path - File path to convert to pattern
 * @returns Pattern with wildcards replacing non-ASCII runs
 */
export function toAsciiPattern(path: string): string {
	// Replace each run of non-ASCII (char code >= 128) with a single "*"
	return path.replace(/[^\x00-\x7F]+/g, '*');
}

/**
 * Check if two paths match via ASCII-sandwich pattern, excluding exact matches.
 *
 * Returns true if:
 * 1. Paths are NOT exactly equal (different non-ASCII content)
 * 2. Their ASCII patterns ARE equal (same ASCII structure)
 * 3. Pattern contains at least one wildcard (has non-ASCII)
 * 4. Pattern has at least one ASCII-NONASCII-ASCII sandwich
 *
 * Examples that match:
 * - "Küçük.md" vs "K眉莽眉k.md" → pattern "K*k.md" (has sandwich)
 * - "file ş.md" vs "file 艧.md" → pattern "file *.md" (has sandwich)
 *
 * Examples that DON'T match:
 * - "Küçük.md" vs "Küçük.md" → exact match, excluded
 * - "Küçük.md" vs "other.md" → different patterns
 * - "あ.md" vs "い.md" → pattern "*.md" (no sandwich, just prefix wildcard)
 * - "test.md" vs "test.md" → no non-ASCII at all
 *
 * @param path1 - First path
 * @param path2 - Second path
 * @returns Match info if suspicious correspondence detected, null otherwise
 */
export function detectSuspiciousCorrespondence(
	path1: string,
	path2: string
): { pattern: string; path1: string; path2: string } | null {
	// Exclude exact matches
	if (path1 === path2) {
		return null;
	}

	const pattern1 = toAsciiPattern(path1);
	const pattern2 = toAsciiPattern(path2);

	// Patterns must match
	if (pattern1 !== pattern2) {
		return null;
	}

	const pattern = pattern1;

	// Must have at least one wildcard (non-ASCII content)
	if (!pattern.includes('*')) {
		return null;
	}

	// Must have at least one ASCII-NONASCII-ASCII sandwich
	// Pattern: non-wildcard, then wildcard, then non-wildcard
	// Regex: [^*]+\*[^*]+ means "1+ non-wildcards, wildcard, 1+ non-wildcards"
	if (!/[^*]+\*[^*]+/.test(pattern)) {
		return null;
	}

	return { pattern, path1, path2 };
}

/**
 * Find all suspicious correspondences between a candidate path and a list of existing paths.
 *
 * @param candidatePath - Path to check (e.g., from remote, to be created locally)
 * @param existingPaths - Existing local paths to compare against
 * @returns Array of matches (empty if none found)
 */
export function findSuspiciousCorrespondences(
	candidatePath: string,
	existingPaths: string[]
): Array<{ pattern: string; candidate: string; existing: string }> {
	const matches: Array<{ pattern: string; candidate: string; existing: string }> = [];

	for (const existingPath of existingPaths) {
		const match = detectSuspiciousCorrespondence(candidatePath, existingPath);
		if (match) {
			matches.push({
				pattern: match.pattern,
				candidate: candidatePath,
				existing: existingPath
			});
		}
	}

	return matches;
}
