/**
 * Structured result types for sync operations
 */

import { ClashStatus, FileOpRecord } from "./fitTypes";
import { VaultError } from "./vault";

/**
 * Sync-specific error for orchestration-level failures that don't come from vaults
 */
export type SyncOrchestrationError = {
	type: 'unknown'
	detailMessage: string
	details?: {
		originalError?: unknown
	}
};

/**
 * Union of vault errors and sync-specific errors
 */
export type SyncError = VaultError | SyncOrchestrationError;

export type SyncResult =
    | { success: true; ops: Array<{ heading: string, ops: FileOpRecord[] }>; clash: ClashStatus[] }
    | { success: false; error: SyncError };

/**
 * Utility functions for creating structured sync errors
 */
export const SyncErrors = {
	unknown: (detailMessage: string, details?: { originalError?: unknown }): SyncOrchestrationError => ({
		type: 'unknown',
		detailMessage,
		details
	})
};
