import { base64ToArrayBuffer, arrayBufferToBase64, TFile, Vault, AbstractInputSuggest, App } from "obsidian";
import { Base64Content, Content, FileContent } from "./contentEncoding";

export function contentToArrayBuffer(content: Base64Content): ArrayBuffer {
	return base64ToArrayBuffer(content as string);
}

export function arrayBufferToContent(buffer: ArrayBuffer): Base64Content {
	return Content.asBase64(arrayBufferToBase64(buffer));
}

/**
 * Decode ArrayBuffer to FileContent with binary detection.
 *
 * Strategy:
 * 1. Check first ~8KB for null bytes (Git's binary detection heuristic)
 * 2. Try UTF-8 decoding with fatal:true
 *    - Success: return as plaintext
 *    - Throws: return as base64 (binary file)
 *
 * The fatal:true flag efficiently detects binary content by throwing on
 * null bytes (0x00) or invalid UTF-8 sequences.
 *
 * @param arrayBuffer - Raw file bytes
 * @returns FileContent with appropriate encoding
 */
export function decodeFileContent(arrayBuffer: ArrayBuffer): FileContent {
	// Check first ~8KB for null bytes (0x00) - Git's proven binary detection heuristic
	// Null bytes are valid UTF-8 (U+0000) but reliably indicate binary files
	const bytes = new Uint8Array(arrayBuffer.slice(0, Math.min(8192, arrayBuffer.byteLength)));
	const hasNullByte = bytes.some(b => b === 0);

	if (hasNullByte) {
		// Binary file - return as base64
		const base64 = arrayBufferToBase64(arrayBuffer);
		return FileContent.fromBase64(base64);
	}

	// No null bytes - try UTF-8 decode with fatal:true (throws on invalid UTF-8)
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
		return FileContent.fromPlainText(text);
	} catch {
		// Invalid UTF-8 (binary file) - return as base64
		const base64 = arrayBufferToBase64(arrayBuffer);
		return FileContent.fromBase64(base64);
	}
}

/**
 * Read file content from Obsidian vault with binary detection.
 *
 * Prevents corruption from vault.read() succeeding on binary files (issue #156).
 *
 * @param vault - Obsidian Vault instance
 * @param path - Path to the file to read
 * @returns FileContent with appropriate encoding
 */
export async function readFileContent(
	vault: Vault,
	path: string
): Promise<FileContent> {
	// Try indexed read first (faster if file is in vault index)
	// Note: getAbstractFileByPath() returns null for hidden files even when they exist
	// See docs/api-compatibility.md "Reading Untracked Files"
	const file = vault.getAbstractFileByPath(path);

	let arrayBuffer: ArrayBuffer;

	if (file) {
		// File found in vault index
		if (!(file instanceof TFile)) {
			throw new Error(`Path is not a file: ${path}`);
		}
		// Read raw bytes (reliable on all platforms, unlike vault.read())
		arrayBuffer = await vault.readBinary(file);
	} else {
		// File not in index - try reading directly from adapter
		// This handles hidden files that Obsidian doesn't track
		try {
			arrayBuffer = await vault.adapter.readBinary(path);
		} catch (error) {
			// Adapter read failed - could be missing file, permissions, I/O error, etc.
			// Re-throw with context but preserve original error message
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to read ${path}: ${message}`);
		}
	}

	// Decode the content (same path for both indexed and unindexed files)
	return decodeFileContent(arrayBuffer);
}

/**
 * Provides autocomplete suggestions for GitHub owners/repos in settings inputs.
 * Works well on both desktop and mobile by positioning suggestions as a popover
 * rather than using native HTML5 datalists which have poor mobile UX (they cover
 * the keyboard and have glitchy behavior).
 *
 * Features:
 * - Popover positioned below input (doesn't cover keyboard on mobile)
 * - Touch-friendly selection
 * - Case-insensitive filtering
 * - Automatically triggers onChange handlers when suggestion selected
 */
export class GitHubOwnerSuggest extends AbstractInputSuggest<string> {
	private ownerList: string[] = [];
	private inputEl: HTMLInputElement;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private getSuggestionsCallback: () => string[]
	) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	/**
	 * Update the available suggestions (e.g., when user authenticates or data changes)
	 */
	updateSuggestions(suggestions: string[]): void {
		this.ownerList = suggestions;
	}

	/**
	 * Filter suggestions based on user input
	 */
	getSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		if (!lowerQuery) {
			// Show all suggestions if input is empty
			return this.ownerList;
		}
		// Filter suggestions that include the query (case-insensitive)
		return this.ownerList.filter(s => s.toLowerCase().includes(lowerQuery));
	}

	/**
	 * Render each suggestion in the popover
	 */
	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	/**
	 * Handle when user selects a suggestion
	 */
	selectSuggestion(value: string, evt: MouseEvent | KeyboardEvent): void {
		// Set the value in the input
		this.setValue(value);
		// Trigger input event so onChange handlers fire
		this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		// Close the suggestion popover
		this.close();
	}
}

/**
 * Provides autocomplete suggestions for GitHub repository names.
 * Separate from owner suggest to allow different suggestion sources.
 */
export class GitHubRepoSuggest extends AbstractInputSuggest<string> {
	private repoList: string[] = [];
	private inputEl: HTMLInputElement;

	constructor(
		app: App,
		inputEl: HTMLInputElement
	) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	/**
	 * Update the available suggestions (e.g., when owner changes or repos are fetched)
	 */
	updateSuggestions(suggestions: string[]): void {
		this.repoList = suggestions;
	}

	/**
	 * Filter suggestions based on user input
	 */
	getSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		if (!lowerQuery) {
			return this.repoList;
		}
		return this.repoList.filter(s => s.toLowerCase().includes(lowerQuery));
	}

	/**
	 * Render each suggestion in the popover
	 */
	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	/**
	 * Handle when user selects a suggestion
	 */
	selectSuggestion(value: string, evt: MouseEvent | KeyboardEvent): void {
		this.setValue(value);
		this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		this.close();
	}
}
