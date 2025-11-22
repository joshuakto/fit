/**
 * Logging infrastructure for the FIT plugin.
 *
 * Provides both a generic Logger class and a FitLogger class specialized for Obsidian integration.
 */

import { Vault } from "obsidian";

/**
 * Maximum length for string values in log output.
 * Longer strings are truncated to prevent log file corruption from
 * accidentally logging large content (e.g., base64 file data in API errors).
 */
export const MAX_LOG_STRING_LENGTH = 2000;

/**
 * Minimal filesystem interface for a single log file.
 * Decouples logger from Obsidian's Vault type for easier testing.
 */
export interface LogFileAdapter {
	/** Read file contents, or null if file doesn't exist */
	read(): Promise<string | null>;
	write(data: string): Promise<void>;
}

/**
 * Configuration options for Logger.
 */
export interface LoggerConfig {
	/** Filesystem adapter for the log file */
	adapter: LogFileAdapter | null;
	/** Maximum log file size in bytes before truncation (default: 1MB) */
	maxLogSize?: number;
}

/**
 * Sanitize data for safe logging, preventing large binary content from corrupting logs.
 * - Truncates long strings (e.g., base64 file content in API error bodies)
 * - Truncates large request.body/response.data fields with size info and preview
 * - Recursively processes nested objects/arrays
 */
function sanitizeForLogging(data: unknown, depth = 0): unknown {
	// Prevent infinite recursion on deeply nested structures
	if (depth > 10) {
		return '[nested too deep]';
	}

	if (data === null || data === undefined) {
		return data;
	}

	if (typeof data === 'string') {
		if (data.length > MAX_LOG_STRING_LENGTH) {
			return `${data.slice(0, MAX_LOG_STRING_LENGTH)}... [truncated ${data.length - MAX_LOG_STRING_LENGTH} chars]`;
		}
		return data;
	}

	if (typeof data !== 'object') {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map(item => sanitizeForLogging(item, depth + 1));
	}

	// Handle plain objects (including Error objects)
	const result: Record<string, unknown> = {};

	// For Error objects, include non-enumerable properties
	if (data instanceof Error) {
		result.name = data.name;
		result.message = sanitizeForLogging(data.message, depth + 1);
	}

	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		// Truncate known large fields that can cause log corruption
		// - request.body contains the full API request payload (may include base64 file content)
		// - response.data may contain large response bodies
		if (key === 'body' || key === 'data') {
			// Check if this looks like an API request/response object
			const parent = data as Record<string, unknown>;
			if ('method' in parent || 'url' in parent || 'status' in parent || 'headers' in parent) {
				const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
				if (valueStr.length > 500) {
					result[key] = `${valueStr.slice(0, 500)}... [${valueStr.length} bytes total]`;
					continue;
				}
			}
		}

		result[key] = sanitizeForLogging(value, depth + 1);
	}
	return result;
}

/**
 * Generic diagnostic logger that writes to both console and an optional log file.
 *
 * Features:
 * - Buffered writes with automatic flushing
 * - Log truncation to prevent unbounded growth
 * - Sanitization of large data (e.g., base64 content)
 * - Defensive error handling that never crashes callers
 */
export class Logger {
	protected adapter: LogFileAdapter | null = null;
	private logBuffer: string[] = [];
	private maxLogSize: number;
	private writeScheduled = false;

	constructor(config: LoggerConfig) {
		this.adapter = config.adapter;
		this.maxLogSize = config.maxLogSize ?? 1000000;
	}

	/**
	 * Logging implementation that can throw errors
	 * Use this when you need to detect logging failures (e.g., in critical error handlers)
	 * For normal operation, use log() which is defensive and never throws
	 * @throws Error if logging fails
	 */
	logUnsafe(tag: string, data?: unknown): void {
		const timestamp = new Date().toISOString();
		let message: string;

		if (data !== undefined) {
			try {
				// Sanitize data to prevent large content from corrupting log file
				const sanitized = sanitizeForLogging(data);
				message = `[${timestamp}] ${tag}: ${JSON.stringify(sanitized, null, 2)}`;
			} catch (e) {
				// Handle circular refs, BigInt, etc.
				message = `[${timestamp}] ${tag}: [Unserializable data: ${e instanceof Error ? e.message : String(e)}]`;
			}
		} else {
			message = `[${timestamp}] ${tag}`;
		}

		// Always log to console for desktop users (defensive)
		try {
			if (data !== undefined) {
				console.log(tag, data);
			} else {
				console.log(tag);
			}
		} catch (_e) {
			// Ignore console errors (e.g., if console is overridden or unavailable)
		}

		// Only write to file if logging is enabled
		if (!this.adapter) {
			return;
		}

		// Buffer for file write
		this.logBuffer.push(message);

		// Schedule async write (debounced)
		if (!this.writeScheduled) {
			this.writeScheduled = true;
			setTimeout(() => this.flushToFile(), 100);
		}
	}

	/**
	 * Log diagnostic information
	 * Writes to both console and file for cross-platform debugging
	 *
	 * Defensive: Never throws - logging failures are silently handled to avoid breaking caller
	 */
	log(tag: string, data?: unknown): void {
		try {
			this.logUnsafe(tag, data);
		} catch (e) {
			// Ultimate safety net - logging should NEVER crash the caller
			// Try to at least report to console that logging failed
			try {
				console.error(`[Logger] FATAL: Logging failed for tag "${tag}". Data:`, data, 'Error:', e);
			} catch (_consoleError) {
				// If even console fails, give up silently
			}
		}
	}

	/**
	 * Force an immediate flush of buffered log entries to file.
	 * Useful for testing or when you need to ensure logs are written before exit.
	 * Returns a promise that resolves when the flush completes.
	 */
	async flush(): Promise<void> {
		await this.flushToFile();
	}

	private async flushToFile() {
		// The writeScheduled flag acts as a lock for the entire async operation.
		// It is only reset when the flush is complete and no more logs are pending.
		if (!this.adapter || this.logBuffer.length === 0) {
			this.writeScheduled = false; // No work to do, release the lock.
			return;
		}

		const messagesToWrite = this.logBuffer.splice(0);
		const newContent = messagesToWrite.join('\n') + '\n';

		try {
			// Use adapter API for cross-platform compatibility (works on mobile!)
			// Read existing log if it exists
			const existingContent = await this.adapter.read() ?? '';

			// Check if file already has UTF-8 BOM
			const hasUtf8Bom = existingContent.length > 0 && existingContent.charCodeAt(0) === 0xFEFF;

			// Append new content
			let updatedContent = existingContent + newContent;

			// Add UTF-8 BOM to beginning if not present
			// This helps browsers correctly identify the file encoding when viewing directly
			if (!hasUtf8Bom) {
				updatedContent = '\uFEFF' + updatedContent;
			}

			// Truncate if too large (keep most recent logs by character count, not line count)
			if (updatedContent.length > this.maxLogSize) {
				// Keep last ~75% of max size to avoid constant truncation
				const keepSize = Math.floor(this.maxLogSize * 0.75);
				let truncatePoint = updatedContent.length - keepSize;

				// Never truncate into the BOM (character 0)
				if (truncatePoint < 1) {
					truncatePoint = 1;
				}

				// Find the start of the next complete log entry (entries start with "[YYYY-MM-DD...")
				const searchContent = updatedContent.slice(truncatePoint);
				const nextEntryMatch = searchContent.match(/\n\[20\d{2}-/);

				let actualTruncatePoint: number;
				if (nextEntryMatch && nextEntryMatch.index !== undefined) {
					actualTruncatePoint = truncatePoint + nextEntryMatch.index + 1; // +1 to skip the newline
				} else {
					// No valid log entry found - content may be corrupted
					// Find next newline to avoid cutting mid-line/mid-character
					const nextNewline = searchContent.indexOf('\n');
					actualTruncatePoint = nextNewline >= 0
						? truncatePoint + nextNewline + 1
						: truncatePoint;
				}

				let keptContent = updatedContent.slice(actualTruncatePoint);

				// Strip any BOM from keptContent (we'll add our own)
				if (keptContent.charCodeAt(0) === 0xFEFF) {
					keptContent = keptContent.slice(1);
				}

				// Safety: if result would still be over limit, force-truncate to keepSize
				// This prevents infinite loops if content is pathological
				if (keptContent.length > keepSize) {
					keptContent = keptContent.slice(keptContent.length - keepSize);
				}

				const truncatedHeader = `[Log truncated - keeping last ~${Math.floor(keptContent.length / 1000)}KB]\n`;

				// Preserve UTF-8 BOM at the start of the file
				updatedContent = '\uFEFF' + truncatedHeader + keptContent;
			}

			await this.adapter.write(updatedContent);
		} catch (error) {
			// Fail silently - don't break sync if logging fails
			console.error('[Logger] Failed to write log file:', error);
		} finally {
			// After the async operation, check if new logs have been buffered.
			if (this.logBuffer.length > 0) {
				// If so, schedule another flush. The lock remains held.
				setTimeout(() => this.flushToFile(), 100);
			} else {
				// If the buffer is empty, the work is done. Release the lock.
				this.writeScheduled = false;
			}
		}
	}
}

/**
 * Obsidian-specific logger implementation for the FIT plugin.
 *
 * Writes logs to `.obsidian/plugins/fit/debug.log` for mobile AND desktop users.
 * Uses vault.adapter API for cross-platform compatibility (works on iOS/Android/desktop).
 * Writing to plugin directory keeps logs out of vault and user's way.
 */
export class FitLogger extends Logger {
	private vault: Vault;
	private pluginDir: string;
	private enabled: boolean = false;

	private _setupAdapter() {
		const logPath = `${this.pluginDir}/debug.log`;
		const vault = this.vault;
		this.adapter = !this.enabled ? null : {
			async read(): Promise<string | null> {
				if (!await vault.adapter.exists(logPath)) return null;
				return vault.adapter.read(logPath);
			},
			async write(data: string): Promise<void> {
				await vault.adapter.write(logPath, data);
			}
		};
	}

	/**
	 * Configure the logger for use (legacy singleton pattern).
	 * For new code, use FitLogger.create() instead.
	 *
	 * @param vault - Obsidian vault for file operations
	 * @param pluginDir - Plugin directory path (e.g., from manifest.dir)
	 */
	configure(vault: Vault, pluginDir: string) {
		this.vault = vault;
		this.pluginDir = pluginDir;
		this._setupAdapter();
	}

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
		this._setupAdapter();
	}
}

// Singleton instance for backward compatibility
export const fitLogger = new FitLogger({
	adapter: null
});
