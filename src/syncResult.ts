/**
 * Structured result types for sync operations
 * Replaces error throwing with explicit error state communication
 */

import { FileOpRecord, ClashStatus } from './fitTypes'

export type SyncErrorType =
  | 'network'           // Network connectivity issues
  | 'auth'              // GitHub authentication failures
  | 'repo_not_found'    // Repository or branch doesn't exist
  | 'conflict'          // Unresolvable merge conflicts
  | 'filesystem'        // Local file system errors
  | 'api_rate_limit'    // GitHub API rate limiting
  | 'unknown'           // Unexpected errors

export type SyncError = {
  type: SyncErrorType
  message: string
  details?: {
    statusCode?: number
    source?: string  // Which operation failed (e.g., 'getRef', 'createCommit')
    retryable?: boolean
  }
}

export type SyncResult = {
  success: true
  operations: Array<{heading: string, ops: FileOpRecord[]}>
  conflicts: ClashStatus[]
} | {
  success: false
  error: SyncError
}

/**
 * Utility functions for creating common error types
 */
export const SyncErrors = {
  network: (message: string, details?: SyncError['details']): SyncError => ({
    type: 'network',
    message,
    details: { retryable: true, ...details }
  }),

  auth: (message: string, details?: SyncError['details']): SyncError => ({
    type: 'auth',
    message,
    details: { retryable: false, ...details }
  }),

  repoNotFound: (message: string, details?: SyncError['details']): SyncError => ({
    type: 'repo_not_found',
    message,
    details: { retryable: false, ...details }
  }),

  rateLimit: (message: string, details?: SyncError['details']): SyncError => ({
    type: 'api_rate_limit',
    message,
    details: { retryable: true, ...details }
  }),

  filesystem: (message: string, details?: SyncError['details']): SyncError => ({
    type: 'filesystem',
    message,
    details: { retryable: false, ...details }
  }),

  unknown: (message: string, details?: SyncError['details']): SyncError => ({
    type: 'unknown',
    message,
    details: { retryable: false, ...details }
  })
}
