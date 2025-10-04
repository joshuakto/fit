/**
 * Test utilities for FIT plugin tests
 */

import { TFile } from 'obsidian';

/**
 * Test stub for TFile that can be constructed with just a path.
 *
 * Note: Obsidian vault paths always use forward slashes, even on Windows.
 *
 * Usage:
 *   const file = StubTFile.ofPath('folder/note.md');
 *   // file.path = 'folder/note.md'
 *   // file.extension = 'md'
 *   // file.basename = 'note'
 *   // file.name = 'note.md'
 */
export class StubTFile extends TFile {
	/**
	 * Create a StubTFile from a file path.
	 * Automatically parses path to populate all TFile properties.
	 */
	static ofPath(filePath: string): TFile {
		const stub = Object.create(TFile.prototype);

		stub.path = filePath;

		// Extract name (last component) from forward-slash path
		const name = filePath.split('/').pop()!;
		stub.name = name;

		// Extract extension (everything after last dot)
		const lastDot = name.lastIndexOf('.');
		if (lastDot > 0) {
			stub.extension = name.substring(lastDot + 1);
			stub.basename = name.substring(0, lastDot);
		} else {
			stub.extension = '';
			stub.basename = name;
		}

		return stub as TFile;
	}
}
