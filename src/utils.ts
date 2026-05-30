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
		protected: "protected",
		pending: "pending"
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
		.setText("Remote version saved to _fit/ — file held pending until resolved");
	conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
		.setText("Resolve: delete _fit/ copy (keep local), or edit either file until they match");

	// Add explanatory notes for special local states
	const hasPending = clashedFiles.some(c => c.localState === 'pending');
	const hasProtected = clashedFiles.some(c => c.localState === 'protected');
	const hasUntracked = clashedFiles.some(c => c.localState === 'untracked');

	if (hasPending) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
			.setText("Pending: unresolved from a prior sync — will keep appearing and local changes won't sync until resolved");
	}
	if (hasProtected) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
			.setText("Protected: path excluded from sync (.obsidian/, _fit/) — saved to _fit/ for transparency, not tracked as pending");
	}
	if (hasUntracked) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
			.setText("Untracked: Could not verify local state - check logs for details");
	}
}
