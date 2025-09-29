/**
 * Structured result types for sync operations
 */

import { ClashStatus, FileOpRecord } from "./fitTypes";

export type SyncErrorType =
  | 'remote_not_found'  // Remote repository, branch, or access issues
  | 'unknown';          // Unexpected errors

export type SyncError = {
	type: SyncErrorType
	technicalMessage: string
	details?: {
		source?: string             // Which operation failed (e.g., 'getRef', 'createCommit')
		originalError?: Error       // Original error object for advanced logging/debugging
	}
};

export type SyncResult =
    | { success: true; ops: Array<{ heading: string, ops: FileOpRecord[] }>; clash: ClashStatus[] }
    | { success: false; error: SyncError };

/**
 * Utility functions for creating structured sync errors
 */
export const SyncErrors = {
	remoteNotFound: (message: string, details?: { source?: string; originalError?: Error }): SyncError => ({
		type: 'remote_not_found',
		technicalMessage: message,
		details
	}),

	unknown: (message: string, details?: { originalError?: Error }): SyncError => ({
		type: 'unknown',
		technicalMessage: message,
		details
	})
};
