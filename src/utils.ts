import { Notice } from "obsidian";
import { ClashStatus, FileOpRecord, LocalFileStatus, RemoteChangeType } from "./fitTypes";

type Status = RemoteChangeType | LocalFileStatus;

type FileLocation = "remote" | "local";

type ComparisonResult<Env extends FileLocation> = {
	path: string,
	status: Env extends "local" ? LocalFileStatus: RemoteChangeType
	currentSha?: string
	extension?: string
};

function getValueOrNull(obj: Record<string, string>, key: string): string | null {
	return obj.hasOwnProperty(key) ? obj[key] : null;
}


// compare currentSha with storedSha and check for differences, files only in currentSha
//  are considerd added, while files only in storedSha are considered removed
export function compareSha<Env extends "remote" | "local">(
	currentShaMap: Record<string, string>,
	storedShaMap: Record<string, string>,
	env: Env): ComparisonResult<Env>[] {
	const determineStatus = (currentSha: string | null, storedSha: string | null): Status | null  =>
	{
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
		const status = determineStatus(currentSha, storedSha);
		if (status) {
			return [{
				path,
				status: status as Env extends "local" ? LocalFileStatus : RemoteChangeType,
				currentSha: currentSha ?? undefined,
				extension: extractExtension(path)
			}];
		}
		return [];
	});
}

export const RECOGNIZED_BINARY_EXT = ["png", "jpg", "jpeg", "pdf"];

/**
 * Git's well-known empty tree SHA - represents a tree with no files
 * This is a constant in Git that always represents an empty tree
 * GitHub API returns 404 when trying to fetch this SHA, so we handle it specially
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function extractExtension(path: string): string | undefined {
	return path.match(/[^.]+$/)?.[0];
}

// Using file extension to determine encoding of files (works in most cases)
export function getFileEncoding(path: string): string {
	const extension = path.match(/[^.]+$/)?.[0];
	const isBinary = extension && RECOGNIZED_BINARY_EXT.includes(extension);
	if (isBinary) {
		return "base64";
	}
	return "utf-8";
}

export function setEqual<T>(arr1: Array<T>, arr2: Array<T>) {
	const set1 = new Set(arr1);
	const set2 = new Set(arr2);
	const isEqual = set1.size === set2.size && [...set1].every(value => set2.has(value));
	return isEqual;
}

export function removeLineEndingsFromBase64String(content: string): string {
	return content.replace(/\r?\n|\r|\n/g, '');
}

export function showFileOpsRecord(records: Array<{heading: string, ops: FileOpRecord[]}>): void {
	console.log(records);
	if (records.length === 0 || records.every(r=>r.ops.length===0)) {return;}
	const fileOpsNotice = new Notice("", 0);
	records.map(recordSet => {
		if (recordSet.ops.length === 0) {return;}
		const heading = fileOpsNotice.noticeEl.createEl("span", {
			cls: "file-changes-heading"
		});
		heading.setText(`${recordSet.heading}\n`);
		const fileChanges = {
			created: [] as Array<string>,
			changed: [] as Array<string>,
			deleted: [] as Array<string>
		};
		for (const op of recordSet.ops) {
			fileChanges[op.status].push(op.path);
		}
		for (const [changeType, paths] of Object.entries(fileChanges)) {
			if (paths.length === 0) {continue;}
			const heading = fileOpsNotice.noticeEl.createEl("span");
			heading.setText(`${changeType.charAt(0).toUpperCase() + changeType.slice(1)}\n`);
			heading.addClass(`file-changes-subheading`);
			for (const path of paths) {
				const listItem = fileOpsNotice.noticeEl.createEl("li", {
					cls: "file-update-row"
				});
				listItem.setText(`${path}`);
				listItem.addClass(`file-${changeType}`);
			}
		}
	});
}

export function showUnappliedConflicts(clashedFiles: Array<ClashStatus>): void {
	if (clashedFiles.length === 0) {return;}
	const localStatusMap = {
		created: "create",
		changed: "change",
		deleted: "delete"
	};
	const remoteStatusMap = {
		ADDED:  "create",
		MODIFIED: "change",
		REMOVED: "delete"
	};
	const conflictNotice = new Notice("", 0);
	const heading = conflictNotice.noticeEl.createEl("span");
	heading.setText(`Change conflicts:\n`);
	heading.addClass(`file-changes-subheading`);
	const conflictStatus = conflictNotice.noticeEl.createDiv({
		cls: "file-conflict-row"
	});
	conflictStatus.createDiv().setText("Local");
	conflictStatus.createDiv().setText("Remote");
	for (const clash of clashedFiles) {
		const conflictItem = conflictNotice.noticeEl.createDiv({
			cls: "file-conflict-row"
		});
		conflictItem.createDiv({
			cls: `file-conflict-${localStatusMap[clash.localStatus]}`
		});
		conflictItem.createDiv("div")
			.setText(clash.path);
		conflictItem.createDiv({
			cls: `file-conflict-${remoteStatusMap[clash.remoteStatus]}`
		});
	}
	const footer = conflictNotice.noticeEl.createDiv({
		cls: "file-conflict-row"
	});
	footer.setText("Note:");
	footer.style.fontWeight = "bold";
	conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
		.setText("Remote changes in _fit");
	conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
		.setText("_fit folder is overwritten on conflict, copy needed changes outside _fit.");
}
