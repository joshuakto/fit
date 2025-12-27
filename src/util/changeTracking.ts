/**
 * Unified change tracking types and utilities
 *
 * This module consolidates change detection, comparison, and conflict tracking.
 */

import { BlobSha } from "./hashing";

/**
 * File change operations - what happened to a file between two states
 *
 * - "ADDED": File exists in current state but not in baseline
 * - "MODIFIED": File exists in both states but content differs (SHA changed)
 * - "REMOVED": File exists in baseline but not in current state
 */
export type ChangeOperation = "ADDED" | "MODIFIED" | "REMOVED";

/** Represents a change detected by comparing file states */
export type FileChange = {
	path: string;
	type: ChangeOperation;
};

/**
 * Represents a snapshot of file states at a point in time.
 * Maps file paths to their content hashes (SHA-1).
 */
export type FileStates = Record<string, BlobSha>;

/**
 * Local state classification for clash resolution
 *
 * When detecting clashes, we need to know the local state:
 * - ChangeOperation: File has a tracked change (ADDED/MODIFIED/REMOVED)
 * - "untracked": File exists but isn't tracked by shouldTrackState(),
 *   so we can't determine its actual state (e.g., hidden files, protected paths)
 */
export type LocalClashState = ChangeOperation | "untracked";

/** Represents a clash between local and remote changes to the same file */
export type FileClash = {
	path: string;
	/** Local state - actual change OR "untracked" if we can't track it */
	localState: LocalClashState;
	/** Remote operation - always a real change */
	remoteOp: ChangeOperation;
};

/**
 * Phase 2a: Determine what filesystem checks are needed
 *
 * Compares local and remote changes to identify paths that need
 * filesystem verification before we can determine if they're safe or clashed.
 *
 * @param localChanges - Changes detected in local vault scan
 * @param remoteChanges - Changes detected in remote vault scan
 * @param localScanPaths - Set of paths found in local scan (tracked files)
 * @returns Paths that need filesystem existence checks
 */
export function determineChecksNeeded(
	localChanges: FileChange[],
	remoteChanges: FileChange[],
	localScanPaths: Set<string>
): {
	needsFilesystemCheck: { path: string; remoteOp: ChangeOperation }[];
} {
	const needsFilesystemCheck: { path: string; remoteOp: ChangeOperation }[] = [];

	// Remote changes for paths not in local scan need filesystem checks
	// (we can't tell if they exist locally and would clash)
	for (const change of remoteChanges) {
		if (!localScanPaths.has(change.path)) {
			needsFilesystemCheck.push({
				path: change.path,
				remoteOp: change.type
			});
		}
	}

	return { needsFilesystemCheck };
}

/**
 * Phase 2b (part 2): Resolve untracked state from filesystem checks
 *
 * Examines remote changes for paths not in tracked local changes to determine:
 * 1. Which paths represent actual local MODIFIED changes (untracked files that changed)
 * 2. Which paths should block remote changes (protected, stat failed, or can't verify)
 *
 * This separates state discovery from clash detection, making Phase 2c simpler.
 *
 * @param remoteChanges - Changes detected in remote vault
 * @param localChangePaths - Set of paths from tracked local changes
 * @param filesystemState - Map of path -> exists (true/false) or null if stat failed
 * @param baselineShas - Baseline SHA cache for detecting unchanged files (#169)
 * @param currentShas - Current SHAs for files that exist locally
 * @param isProtectedPath - Function to check if path is protected
 * @returns Set of paths that should block remote changes
 */
export function resolveUntrackedState(
	remoteChanges: FileChange[],
	localChangePaths: Set<string>,
	filesystemState: Map<string, boolean | null>,
	baselineShas: FileStates,
	currentShas: Map<string, BlobSha>,
	isProtectedPath: (path: string) => boolean
): Set<string> {
	const blockedPaths = new Set<string>();

	for (const remoteChange of remoteChanges) {
		// Skip paths already in tracked local changes (will be handled as clashes in Phase 2c)
		if (localChangePaths.has(remoteChange.path)) {
			continue;
		}

		const existsLocally = filesystemState.get(remoteChange.path);

		// If path wasn't stat'd, it means it was in the local scan (tracked file)
		// These are already fully handled by tracked localChanges
		if (existsLocally === undefined) {
			continue;
		}

		// Case 1: Stat failed - can't verify, block conservatively
		if (existsLocally === null) {
			blockedPaths.add(remoteChange.path);
			continue;
		}

		// Case 2: Protected path - policy block
		if (isProtectedPath(remoteChange.path)) {
			blockedPaths.add(remoteChange.path);
			continue;
		}

		// Case 3: File doesn't exist locally - clear for remote (no action needed)
		if (existsLocally === false) {
			continue;
		}

		// Case 4: File exists locally but wasn't in scan (untracked)
		// Check if it's unchanged from baseline (#169)
		const baselineSha = baselineShas[remoteChange.path];
		const currentSha = currentShas.get(remoteChange.path);

		if (baselineSha && currentSha && currentSha === baselineSha) {
			// Unchanged from baseline - clear for remote (no action needed)
			continue;
		}

		// Either no baseline OR file changed from baseline - block to prevent data loss
		blockedPaths.add(remoteChange.path);
	}

	return blockedPaths;
}

/**
 * Phase 2c: Resolve all changes to final safe/clash outcomes
 *
 * Simple clash detection between complete local changes (tracked + untracked)
 * and remote changes, with additional blocking for paths that can't be verified.
 *
 * @param localChanges - All local changes (tracked + untracked from resolveUntrackedState)
 * @param remoteChanges - Changes detected in remote vault
 * @param shouldBlockRemote - Predicate for paths that block remote (from resolveUntrackedState)
 * @returns Final categorization into safe changes and clashes
 */
export function resolveAllChanges(
	localChanges: FileChange[],
	remoteChanges: FileChange[],
	shouldBlockRemote: (path: string) => boolean
): {
	safeLocal: FileChange[];
	safeRemote: FileChange[];
	clashes: FileClash[];
} {
	const localChangePaths = new Set(localChanges.map(c => c.path));

	const safeLocal: FileChange[] = [];
	const safeRemote: FileChange[] = [];
	const clashes: FileClash[] = [];

	// Process all local changes
	for (const localChange of localChanges) {
		const remoteChange = remoteChanges.find(c => c.path === localChange.path);

		if (remoteChange) {
			// Both sides changed - definite clash
			clashes.push({
				path: localChange.path,
				localState: localChange.type,
				remoteOp: remoteChange.type
			});
		} else {
			// Only local changed - safe to push
			safeLocal.push(localChange);
		}
	}

	// Process all remote changes
	for (const remoteChange of remoteChanges) {
		if (localChangePaths.has(remoteChange.path)) {
			// Already handled as clash above
			continue;
		}

		if (shouldBlockRemote(remoteChange.path)) {
			// Blocked (stat failed, protected, or can't verify) - treat as clash
			clashes.push({
				path: remoteChange.path,
				localState: 'untracked',
				remoteOp: remoteChange.type
			});
		} else {
			// No local change, not blocked - safe to apply
			safeRemote.push(remoteChange);
		}
	}

	return { safeLocal, safeRemote, clashes };
}

/**
 * Compare current vs stored file state and detect changes
 *
 * Files only in currentShaMap are considerd added, while files only in storedShaMap are considered
 * removed.
 *
 * @param currentShaMap - Current file state (path -> SHA)
 * @param storedShaMap - Baseline file state (path -> SHA)
 * @returns Array of detected changes
 */
export function compareFileStates(
	currentShaMap: FileStates,
	storedShaMap: FileStates
): FileChange[] {
	const getValueOrNull = <T>(obj: Record<string, T>, key: string): T | null =>
		obj.hasOwnProperty(key) ? obj[key] : null;

	const determineChangeType = (
		currentSha: BlobSha | null,
		storedSha: BlobSha | null
	): ChangeOperation | null => {
		if (currentSha && storedSha && currentSha !== storedSha) {
			return "MODIFIED";
		} else if (currentSha && !storedSha) {
			return "ADDED";
		} else if (!currentSha && storedSha) {
			return "REMOVED";
		}
		return null;
	};

	return Object.keys({ ...currentShaMap, ...storedShaMap }).flatMap((path): FileChange[] => {
		const [currentSha, storedSha] = [
			getValueOrNull(currentShaMap, path),
			getValueOrNull(storedShaMap, path)
		];
		const changeType = determineChangeType(currentSha, storedSha);
		if (changeType) {
			return [{
				path,
				type: changeType,
			}];
		}
		return [];
	});
}
