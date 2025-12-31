import { Notice } from "obsidian";
import { ChangeOperation, FileChange, FileClash, LocalClashState } from "./util/changeTracking";

export function extractExtension(path: string): string | undefined {
	return path.match(/[^.]+$/)?.[0];
}

// Using file extension to determine encoding of files (works in most cases)
export function setEqual<T>(arr1: Array<T>, arr2: Array<T>) {
	const set1 = new Set(arr1);
	const set2 = new Set(arr2);
	const isEqual = set1.size === set2.size && [...set1].every(value => set2.has(value));
	return isEqual;
}

export function showFileChanges(records: Array<{heading: string, changes: FileChange[]}>): void {
	console.log(records);
	if (records.length === 0 || records.every(r=>r.changes.length===0)) {return;}
	const fileOpsNotice = new Notice("", 0);
	records.map(recordSet => {
		if (recordSet.changes.length === 0) {return;}
		const heading = fileOpsNotice.noticeEl.createEl("span", {
			cls: "file-changes-heading"
		});
		heading.setText(`${recordSet.heading}\n`);
		const fileChanges: Record<ChangeOperation, string[]> = {
			ADDED: [],
			MODIFIED: [],
			REMOVED: []
		};
		for (const op of recordSet.changes) {
			fileChanges[op.type].push(op.path);
		}
		for (const [changeType, paths] of Object.entries(fileChanges)) {
			if (paths.length === 0) {continue;}
			const heading = fileOpsNotice.noticeEl.createEl("span");
			heading.setText(`${changeType.charAt(0).toUpperCase() + changeType.slice(1).toLowerCase()}\n`);
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

export function showUnappliedConflicts(clashedFiles: Array<FileClash>): void {
	if (clashedFiles.length === 0) {return;}
	const localStatusMap: Record<LocalClashState, string> = {
		ADDED: "create",
		MODIFIED: "change",
		REMOVED: "delete",
		untracked: "untracked",
		protected: "protected"
	};
	const remoteStatusMap: Record<ChangeOperation, string> = {
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
			cls: `file-conflict-${localStatusMap[clash.localState]}`
		});
		conflictItem.createDiv("div")
			.setText(clash.path);
		conflictItem.createDiv({
			cls: `file-conflict-${remoteStatusMap[clash.remoteOp]}`
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

	// Add explanatory notes for special local states
	const hasProtected = clashedFiles.some(c => c.localState === 'protected');
	const hasUntracked = clashedFiles.some(c => c.localState === 'untracked');

	if (hasProtected) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
			.setText("Protected: Paths excluded from sync by policy (.obsidian/, _fit/)");
	}
	if (hasUntracked) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
			.setText("Untracked: Could not verify local state - check logs for details");
	}
}
