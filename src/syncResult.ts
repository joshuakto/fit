/**
 * Structured result types for sync operations
 */

import { ClashStatus, FileOpRecord } from "./fitTypes";

export type SyncErrorType =
  | 'network'           // General networking problem (request failure without HTTP status)
  | 'api_error'         // API response errors (rate limiting, server errors, etc.)
  | 'remote_access'     // Authentication/authorization failures (401, 403)
  | 'remote_not_found'  // Remote repository, branch, or access issues (404)
  | 'filesystem'        // Local file system errors
  | 'unknown';          // Unexpected errors

export type SyncError = {
	type: SyncErrorType
	/**
	 * User-friendly error description with specific requirements:
	 * - Actually describes error, summarizing low-level specifics available only at sync level (status codes, operation context)
	 * - Avoid redundant repetition of type name
	 * - Should include specific info from the actual error unless it's extremely self-explanatory
	 */
	detailMessage: string
	details?: {
		source?: string           // Which operation failed (useful for debugging context)
		originalError?: unknown   // Original error object for advanced logging/debugging
	}
};

export type SyncResult =
    | { success: true; ops: Array<{ heading: string, ops: FileOpRecord[] }>; clash: ClashStatus[] }
    | { success: false; error: SyncError };

/**
 * Utility functions for creating structured sync errors
 */
export const SyncErrors = {
	network: (detailMessage: string, details?: { source?: string, originalError?: Error }): SyncError => ({
		type: 'network',
		detailMessage,
		details
	}),

	apiError: (detailMessage: string, details?: { source?: string; originalError?: Error }): SyncError => ({
		type: 'api_error',
		detailMessage,
		details
	}),

	remoteAccess: (detailMessage: string, details?: { source?: string; originalError?: Error }): SyncError => ({
		type: 'remote_access',
		detailMessage,
		details
	}),

	remoteNotFound: (detailMessage: string, details?: { source?: string; originalError?: Error }): SyncError => ({
		type: 'remote_not_found',
		detailMessage,
		details
	}),

	filesystem: (detailMessage: string, details?: { originalError?: Error }): SyncError => ({
		type: 'filesystem',
		detailMessage,
		details
	}),

	unknown: (detailMessage: string, details?: { originalError?: Error }): SyncError => ({
		type: 'unknown',
		detailMessage,
		details
	})
};
