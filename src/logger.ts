/**
 * Diagnostic logger for FIT plugin
 *
 * Writes logs to .obsidian/plugins/fit/debug.log for mobile AND desktop users.
 * Uses vault.adapter API for cross-platform compatibility (works on iOS/Android/desktop).
 * Writing to plugin directory keeps logs out of vault and user's way.
 */

import { Vault } from "obsidian";

export class FitLogger {
	private vault: Vault | null = null;
	private logBuffer: string[] = [];
	private pluginDir: string | null = null; // Set from plugin's manifest.dir
	private readonly LOG_FILE_NAME = "debug.log";
	private readonly MAX_LOG_SIZE = 1000000; // ~1MB, enough for many sync operations
	private writeScheduled = false;
	private loggingEnabled = false; // Disabled by default

	setVault(vault: Vault) {
		this.vault = vault;
	}

	setPluginDir(dir: string) {
		this.pluginDir = dir;
	}

	setEnabled(enabled: boolean) {
		this.loggingEnabled = enabled;
	}

	private getLogPath(): string | null {
		if (!this.pluginDir) return null;
		return `${this.pluginDir}/${this.LOG_FILE_NAME}`;
	}

	/**
	 * Log diagnostic information
	 * Writes to both console and file for cross-platform debugging
	 */
	log(tag: string, data: unknown) {
		const timestamp = new Date().toISOString();
		const message = `[${timestamp}] ${tag}: ${JSON.stringify(data, null, 2)}`;

		// Always log to console for desktop users
		console.log(tag, data);

		// Only write to file if logging is enabled
		if (!this.loggingEnabled) {
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

	private async flushToFile() {
		this.writeScheduled = false;

		if (!this.vault || this.logBuffer.length === 0) {
			return;
		}

		const logPath = this.getLogPath();
		if (!logPath) {
			return; // Plugin dir not set yet
		}

		const messagesToWrite = this.logBuffer.splice(0);
		const newContent = messagesToWrite.join('\n') + '\n';

		try {
			// Use vault.adapter API for cross-platform compatibility (works on mobile!)
			// Read existing log if it exists
			let existingContent = '';
			if (await this.vault.adapter.exists(logPath)) {
				existingContent = await this.vault.adapter.read(logPath);
			}

			// Append new content
			let updatedContent = existingContent + newContent;

			// Truncate if too large (keep most recent logs by character count, not line count)
			if (updatedContent.length > this.MAX_LOG_SIZE) {
				// Keep last ~75% of max size to avoid constant truncation
				const keepSize = Math.floor(this.MAX_LOG_SIZE * 0.75);
				const truncatePoint = updatedContent.length - keepSize;

				// Find the start of the next complete log entry (entries start with "[YYYY-MM-DD...")
				const nextEntryMatch = updatedContent.slice(truncatePoint).match(/\n\[20\d{2}-/);
				const actualTruncatePoint = nextEntryMatch
					? truncatePoint + nextEntryMatch.index! + 1  // +1 to skip the newline
					: truncatePoint;

				const truncatedHeader = `[Log truncated - keeping last ~${Math.floor((updatedContent.length - actualTruncatePoint) / 1000)}KB]\n`;
				updatedContent = truncatedHeader + updatedContent.slice(actualTruncatePoint);
			}

			await this.vault.adapter.write(logPath, updatedContent);
		} catch (error) {
			// Fail silently - don't break sync if logging fails
			console.error('[FitLogger] Failed to write log file:', error);
		}
	}
}

// Singleton instance
export const fitLogger = new FitLogger();
