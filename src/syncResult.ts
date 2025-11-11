/**
 * Structured result types for sync operations
 */

import { FileChange, FileClash  } from "./util/changeTracking";
import { VaultError } from "./vault";

/**
 * Sync-specific error for orchestration-level failures that don't come from vaults
 */
export type SyncOrchestrationError = {
	type: 'unknown' | 'already-syncing'
	detailMessage: string
	details?: {
		originalError?: unknown
	}
};

/**
 * Union of vault errors and sync-specific errors
 */
export type SyncError = VaultError | SyncOrchestrationError;

// Suggested: { success: true; changes: Array<{ heading: string, files: FileChange[] }>; clash: FileClash[] }
export type SyncResult =
    | { success: true; changeGroups: Array<{ heading: string, changes: FileChange[] }>; clash: FileClash[] }
    | { success: false; error: SyncError };

/**
 * Utility functions for creating structured sync errors
 */
export const SyncErrors = {
	unknown: (detailMessage: string, details?: { originalError?: unknown }): SyncOrchestrationError => ({
		type: 'unknown',
		detailMessage,
		details
	}),
	alreadySyncing: (detailMessage: string = 'Sync already in progress'): SyncOrchestrationError => ({
		type: 'already-syncing',
		detailMessage
	})
};
