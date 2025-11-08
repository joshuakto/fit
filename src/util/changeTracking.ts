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

/**
 * @deprecated Use ChangeOperation instead
 */
export type LocalChangeOperation = "deleted" | "created" | "changed";

export type FileChange = {
	path: string;
	type: ChangeOperation;
	/** SHA of file in current state (undefined for REMOVED files) */
	currentSha?: BlobSha;
};

export type LocalChange = {
	path: string;
	type: LocalChangeOperation;
};

/**
 * Represents a clash between local and remote changes to the same file
 */
export type FileClash = {
	path: string;
	/** Local state - actual change OR "untracked" if we can't track it */
	localState: LocalChangeOperation | "untracked";
	/** Remote operation - always a real change */
	remoteOp: ChangeOperation;
};

export type FileLocation = "remote" | "local";
export type ComparisonResult<Env extends FileLocation> = {
	path: string;
	type: Env extends "local" ? LocalChangeOperation : ChangeOperation;
	currentSha?: BlobSha;
};

/**
 * Compare currentSha with storedSha and check for differences.
 *
 * Files only in currentSha are considerd added, while files only in storedSha are considered
 * removed.
 *
 * @param currentShaMap - Current file state (path -> SHA)
 * @param storedShaMap - Baseline file state (path -> SHA)
 * @returns Array of detected changes
 */
export function compareFileStates<Env extends FileLocation>(
	currentShaMap: Record<string, BlobSha>,
	storedShaMap: Record<string, BlobSha>,
	env: Env): ComparisonResult<Env>[] {
	const getValueOrNull = <T>(obj: Record<string, T>, key: string): T | null =>
		obj.hasOwnProperty(key) ? obj[key] : null;

	const determineStatus = (currentSha: BlobSha | null, storedSha: BlobSha | null): ChangeOperation | LocalChangeOperation | null => {
		if (currentSha && storedSha && currentSha !== storedSha) {
			return env === "local" ? "changed" : "MODIFIED";
		} else if (currentSha && !storedSha) {
			return env === "local" ? "created" : "ADDED";
		} else if (!currentSha && storedSha) {
			return env === "local" ? "deleted" : "REMOVED";
		}
		return null;
	};

	return Object.keys({ ...currentShaMap, ...storedShaMap }).flatMap((path): ComparisonResult<Env>[] => {
		const [currentSha, storedSha] = [getValueOrNull(currentShaMap, path), getValueOrNull(storedShaMap, path)];
		const changeType = determineStatus(currentSha, storedSha);
		if (changeType) {
			return [{
				path,
				type: changeType as Env extends "local" ? LocalChangeOperation : ChangeOperation,
				currentSha: currentSha ?? undefined
			}];
		}
		return [];
	});
}

