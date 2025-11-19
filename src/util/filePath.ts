/**
 * Type-safe file path utilities for sync operations
 *
 * Design principles:
 * - Branded string type for compile-time safety
 * - All paths normalized to NFC (composed Unicode form)
 * - Platform-agnostic (forward slashes, no Node.js dependencies)
 * - Namespace pattern for cohesive API with single import
 *
 * Usage:
 *   import { FilePath } from './util/filePath';
 *   const path = FilePath.create(rawPath);
 *   if (FilePath.isHidden(path)) { ... }
 */

import { fitLogger } from '@/logger';

/**
 * Branded type for normalized file paths
 * Always in NFC (composed) Unicode normalization form
 * Always uses forward slashes as path separator
 */
export type FilePath = string & { readonly __brand: 'FilePath' };

/**
 * File extension without leading dot (e.g., "md", "png")
 */
export type FileExtension = string & { readonly __brand: 'FileExtension' };

/**
 * FilePath namespace - provides all path operations
 */
export const FilePath = {
	/**
	 * Create a FilePath from a raw string, normalizing to NFC
	 *
	 * NFC (Composed) form is chosen because:
	 * - Most common on Windows/Linux/Android
	 * - More compact than NFD
	 * - Consistent with GitHub API expectations
	 *
	 * @param rawPath - Raw path string from Obsidian or GitHub
	 * @returns Normalized FilePath in NFC form
	 */
	create: (rawPath: string): FilePath => {
		return rawPath.normalize('NFC') as FilePath;
	},

	/**
	 * Extract file extension from path
	 *
	 * Follows Python pathlib convention: files starting with dot have no extension
	 *
	 * @param path - FilePath to extract extension from
	 * @returns Extension without leading dot, or null if no extension
	 *
	 * @example
	 *   FilePath.getExtension(FilePath.create("notes/daily.md")) // => "md"
	 *   FilePath.getExtension(FilePath.create("README")) // => null
	 *   FilePath.getExtension(FilePath.create(".gitignore")) // => null
	 *   FilePath.getExtension(FilePath.create(".obsidian/app.json")) // => "json"
	 */
	getExtension: (path: FilePath): FileExtension | null => {
		// Extract basename (last segment after final slash)
		const basename = path.split('/').pop() || '';

		// Files starting with dot have no extension (like Python's pathlib)
		// Examples: .gitignore, .DS_Store
		if (basename.startsWith('.')) {
			return null;
		}

		// Match: must have a dot, then capture everything after the last dot
		const match = basename.match(/\.([^.]+)$/);
		return match ? (match[1] as FileExtension) : null;
	},

	/**
	 * Extract filename (last path component) from path
	 *
	 * @param path - FilePath to extract filename from
	 * @returns Filename (last component after final slash)
	 *
	 * @example
	 *   FilePath.getName(FilePath.create("notes/daily.md")) // => "daily.md"
	 *   FilePath.getName(FilePath.create("README")) // => "README"
	 *   FilePath.getName(FilePath.create(".gitignore")) // => ".gitignore"
	 */
	getName: (path: FilePath): string => {
		return path.split('/').pop() || '';
	},

	/**
	 * Check if path is hidden (starts with . or contains /.)
	 *
	 * Hidden paths include:
	 * - Files starting with dot: .gitignore, .DS_Store
	 * - Files in hidden directories: .obsidian/config.json
	 * - Nested hidden dirs: folder/.hidden/file.md
	 *
	 * @param path - FilePath to check
	 * @returns true if path is hidden
	 */
	isHidden: (path: FilePath): boolean => {
		const segments = path.split('/');
		return segments.some(segment => segment.startsWith('.'));
	},

	/**
	 * Get debug information about a path's normalization state
	 *
	 * Useful for diagnosing Unicode normalization issues
	 *
	 * @param path - FilePath to analyze
	 * @returns Debug information including normalization form and byte length
	 */
	getDebugInfo: (path: FilePath): {
		path: string;
		isNfc: boolean;
		isNfd: boolean;
		hasNonAscii: boolean;
		charLength: number;
		byteLength: number;
	} => {
		const nfc = path.normalize('NFC');
		const nfd = path.normalize('NFD');

		return {
			path,
			isNfc: path === nfc,
			isNfd: path === nfd,
			hasNonAscii: /[^\x00-\x7F]/.test(path),
			charLength: path.length,
			byteLength: new TextEncoder().encode(path).length
		};
	},

	/**
	 * Convert FilePath back to raw string (for interop with existing code)
	 *
	 * @param path - FilePath to convert
	 * @returns Raw string value
	 */
	toRaw: (path: FilePath): string => {
		return path;
	},
} as const;

/**
 * Detect normalization issues in a batch of paths and log warnings
 *
 * Used for diagnostic logging to identify Unicode normalization problems
 * that can cause file duplication (issue #51)
 *
 * @param paths - Array of raw path strings to analyze
 * @param source - Description of where paths came from (e.g., "local", "remote")
 */
export function detectNormalizationIssues(paths: string[], source: string): void {

	const nonNfcPaths: Array<{
		path: string;
		form: string;
		charLength: number;
		byteLength: number;
	}> = [];
	const nonAsciiPaths: string[] = [];

	for (const path of paths) {
		const hasNonAscii = /[^\x00-\x7F]/.test(path);
		if (hasNonAscii) {
			nonAsciiPaths.push(path);

			const nfc = path.normalize('NFC');
			const nfd = path.normalize('NFD');

			// Determine normalization form
			let form: string;
			if (path === nfc && path === nfd) {
				form = 'NFC/NFD'; // ASCII or same in both
			} else if (path === nfc) {
				form = 'NFC';
			} else if (path === nfd) {
				form = 'NFD';
			} else {
				form = 'mixed';
			}

			if (form === 'NFD') {
				nonNfcPaths.push({
					path,
					form,
					charLength: path.length,
					byteLength: new TextEncoder().encode(path).length
				});
			}
		}
	}

	// Log summary if we found non-ASCII paths
	if (nonAsciiPaths.length > 0) {
		fitLogger.log(`[PathNormalization] Non-ASCII paths detected in ${source}`, {
			totalPaths: paths.length,
			nonAsciiCount: nonAsciiPaths.length,
			nfdCount: nonNfcPaths.length,
			nfcCount: nonAsciiPaths.length - nonNfcPaths.length
		});

		// Log detailed info for NFD paths (potential issue)
		if (nonNfcPaths.length > 0) {
			fitLogger.log(`[PathNormalization] ⚠️  NFD-normalized paths found in ${source}`, {
				warning: 'These paths may cause duplication if synced with NFC-normalized systems',
				issue: 'https://github.com/joshuakto/fit/issues/51',
				paths: nonNfcPaths.map(info => ({
					...info,
					nfcEquivalent: info.path.normalize('NFC'),
					differentWhenNormalized: info.path !== info.path.normalize('NFC')
				}))
			});
		}
	}
}

/**
 * Compare two path arrays to find normalization mismatches
 *
 * Detects cases where the same logical file appears with different
 * normalization forms (e.g., NFD locally, NFC remotely).
 *
 * @param localPaths - Paths from local filesystem
 * @param remotePaths - Paths from remote (GitHub)
 */
export function detectNormalizationMismatches(localPaths: string[], remotePaths: string[]): void {

	const remoteNormalizedMap = new Map(remotePaths.map(p => [p.normalize('NFC'), p]));

	const mismatches: Array<{
		localPath?: string;
		remotePath?: string;
		normalizedForm: string;
	}> = [];

	// Check for files that exist in both but with different normalization
	for (const localPath of localPaths) {
		const nfc = localPath.normalize('NFC');

		// If local path is NFD but remote has NFC version
		if (localPath !== nfc) {
			// Find the actual remote path
			const remotePath = remoteNormalizedMap.get(nfc);

			if (remotePath && remotePath !== localPath) {
				mismatches.push({
					localPath,
					remotePath,
					normalizedForm: nfc
				});
			}
		}
	}

	if (mismatches.length > 0) {
		const getInfo = (path: string) => {
			const nfc = path.normalize('NFC');
			const nfd = path.normalize('NFD');
			let form: string;
			if (path === nfc) form = 'NFC';
			else if (path === nfd) form = 'NFD';
			else form = 'mixed';

			return {
				form,
				bytes: new TextEncoder().encode(path).length
			};
		};

		fitLogger.log('[PathNormalization] 🔴 NORMALIZATION MISMATCH DETECTED', {
			error: 'Same file exists with different Unicode normalization forms',
			impact: 'This will cause file duplication and sync conflicts',
			issue: 'https://github.com/joshuakto/fit/issues/51',
			mismatches: mismatches.map(m => ({
				localPath: m.localPath,
				localForm: m.localPath ? getInfo(m.localPath).form : 'N/A',
				localBytes: m.localPath ? getInfo(m.localPath).bytes : 0,
				remotePath: m.remotePath,
				remoteForm: m.remotePath ? getInfo(m.remotePath).form : 'N/A',
				remoteBytes: m.remotePath ? getInfo(m.remotePath).bytes : 0,
				normalizedForm: m.normalizedForm,
				visuallyIdentical: true
			}))
		});
	}
}
