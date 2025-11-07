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
	currentShaMap: Record<string, BlobSha>,
	storedShaMap: Record<string, BlobSha>
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
