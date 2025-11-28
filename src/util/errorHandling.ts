/**
 * Critical error handling utilities
 *
 * Provides defensive error handling for plugin-critical failures where
 * even the error reporting mechanisms (logger, Notice) might fail.
 */

import { Notice } from 'obsidian';

export interface CriticalErrorOptions {
	logger?: { logUnsafe: (tag: string, data?: unknown) => void };
	showNotice?: boolean;
}

/**
 * Handle critical plugin errors with defensive fallbacks
 *
 * Attempts to report errors through multiple channels:
 * 1. Console (always attempted first)
 * 2. File logger (if provided)
 * 3. User-facing Notice (if enabled)
 *
 * Never throws - each reporting channel is tried independently with its own error handling.
 *
 * @param context - Brief description of what failed (e.g., "Plugin failed to load")
 * @param error - The error that occurred
 * @param options - Optional logger and Notice display control
 */
export function handleCriticalError(
	context: string,
	error: unknown,
	options: CriticalErrorOptions = {}
): void {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const errorStack = error instanceof Error ? error.stack : undefined;

	// Track what succeeded/failed for comprehensive reporting (null = success)
	let logError: unknown = null;
	let noticeError: unknown = null;

	// Always log to console first (most reliable diagnostic channel)
	try {
		console.error(`[Fit] FATAL: ${context}:`, error);
	} catch (_e) {
		// Console failure is extremely rare, but we continue with other channels
	}

	// Try to log to file for diagnostics (defensive: never throw)
	if (options.logger) {
		try {
			options.logger.logUnsafe(`[Plugin] FATAL: ${context}`, {
				error: errorMessage,
				stack: errorStack,
				timestamp: new Date().toISOString()
			});
		} catch (err) {
			logError = err;
		}
	}

	// Try to show user-facing error notice (defensive: never throw)
	if (options.showNotice) {
		try {
			// Craft message based on what succeeded/failed
			const noticeMessage = logError === null
				? `Fit: ${context}\n\n${errorMessage}\n\nCheck .obsidian/plugins/fit/debug.log for details.`
				: `Fit: ${context}\n\n${errorMessage}\n\nAdditionally, logging to debug.log failed. Check the console for details.`;
			new Notice(noticeMessage, 0); // Don't auto-hide critical errors
		} catch (err) {
			noticeError = err;

			// If Notice fails but logging worked, try to log the Notice failure
			if (logError === null && options.logger) {
				try {
					options.logger.logUnsafe('[Plugin] FATAL: Failed to show error notice', {
						noticeError: noticeError instanceof Error ? noticeError.message : String(noticeError),
						noticeStack: noticeError instanceof Error ? noticeError.stack : undefined,
						originalError: errorMessage,
						originalStack: errorStack
					});
				} catch (_logError) {
					// If logging also fails, fall through to console fallback
				}
			}
		}
	}

	// Console fallback: Report the full picture of what succeeded/failed
	if (logError !== null || noticeError !== null) {
		try {
			if (logError !== null) {
				console.error('[Fit] Additionally, logging to debug.log failed:', logError);
			}
			if (noticeError !== null) {
				console.error('[Fit] Additionally, failed to show error notice:', noticeError);
			}
		} catch (_consoleError) {
			// Ultimate fallback: if even console.error fails, there's nothing more we can do
		}
	}
}
