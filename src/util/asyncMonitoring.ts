import {fitLogger} from '../logger';

/**
 * Monitors a promise and logs a single warning if it takes longer than expected.
 *
 * This is useful for detecting operations that might be blocking the main thread
 * for extended periods on mobile devices (which can lead to crashes). The warning
 * appears in debug.log to help diagnose which operation was running if a crash occurs.
 *
 * Does NOT log operation start/completion - relies on existing logging around
 * the monitored operation for timing context.
 *
 * @param promise The promise to monitor
 * @param operationName Human-readable name for logging (e.g., "Local vault SHA computation")
 * @param options Monitoring configuration
 * @returns The same promise (pass-through)
 *
 * @example
 * const result = await withSlowOperationMonitoring(
 *   Promise.all(shaComputations),
 *   "SHA computation for 100 files",
 *   { warnAfterMs: 10000 }
 * );
 */
export async function withSlowOperationMonitoring<T>(
	promise: Promise<T>,
	operationName: string,
	options: {
		/** Log warning after this many ms (default: 10000 = 10s) */
		warnAfterMs?: number;
	} = {}
): Promise<T> {
	const warnAfterMs = options.warnAfterMs ?? 10000;

	let completed = false;

	// Schedule single warning if threshold exceeded
	const warningTimer = setTimeout(() => {
		if (completed) return;

		const thresholdSec = (warnAfterMs / 1000).toFixed(1);

		fitLogger.log('[Performance Warning] Slow operation detected', {
			operation: operationName,
			message: `Operation still running after ${thresholdSec}s`
		});
	}, warnAfterMs);

	try {
		const result = await promise;
		completed = true;
		clearTimeout(warningTimer);
		return result;
	} catch (error) {
		completed = true;
		clearTimeout(warningTimer);
		throw error;
	}
}

