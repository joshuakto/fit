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

export function showFileChanges(
	records: Array<{heading: string, changes: FileChange[]}>,
	fieldWarnings: Map<string, string[]> = new Map(),
	durationMs = 0
): void {
	console.log(records);
	if (records.length === 0 || records.every(r=>r.changes.length===0)) {return;}
	const fileOpsNotice = new Notice("", durationMs);
	records.map(recordSet => {
		if (recordSet.changes.length === 0) {return;}
		const heading = fileOpsNotice.noticeEl.createEl("span", {
			cls: "file-changes-heading"
		});
		heading.setText(`${recordSet.heading}\n`);
		const fileChanges: Record<ChangeOperation, FileChange[]> = {
			ADDED: [],
			MODIFIED: [],
			REMOVED: []
		};
		for (const op of recordSet.changes) {
			fileChanges[op.type].push(op);
		}
		for (const [changeType, ops] of Object.entries(fileChanges)) {
			if (ops.length === 0) {continue;}
			const heading = fileOpsNotice.noticeEl.createEl("span");
			heading.setText(`${changeType.charAt(0).toUpperCase() + changeType.slice(1).toLowerCase()}\n`);
			heading.addClass(`file-changes-subheading`);
			for (const op of ops) {
				const path = op.path;
				const listItem = fileOpsNotice.noticeEl.createEl("li", {
					cls: "file-update-row"
				});
				listItem.addClass(`file-${changeType}`);
				const newFields = fieldWarnings.get(path);
				if (newFields?.length) {
					listItem.createSpan({ text: path });
					listItem.createSpan({ text: ` — new field${newFields.length > 1 ? 's' : ''}: ` });
					newFields.forEach((f, i) => {
						if (i > 0) listItem.createSpan({ text: ', ' });
						listItem.createEl('code', { text: f, cls: 'fit-field-warning-field' });
					});
				} else if (op.note) {
					// Same MODIFIED styling, but the note distinguishes it from a real content
					// change (e.g. an untrack notice: nothing was edited, just left in place).
					listItem.createSpan({ text: path });
					listItem.createSpan({ text: ` (${op.note})`, cls: 'file-change-note-text' });
				} else {
					listItem.setText(path);
				}
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
	for (const note of conflictNoticeNotes(clashedFiles)) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"}).setText(note);
	}
}

/** Footer notes for the conflicts notice. A clash against a remote deletion has no `_fit/` copy. */
export function conflictNoticeNotes(clashedFiles: Array<FileClash>): string[] {
	const deletedRemotely = clashedFiles.filter(c => c.remoteOp === 'REMOVED' && c.localState !== 'pending');
	const savedToFit = clashedFiles.filter(c => !deletedRemotely.includes(c));
	const notes: string[] = [];

	if (savedToFit.length > 0) {
		notes.push("Remote version saved to _fit/ — file held pending until resolved");
		notes.push("Resolve: delete _fit/ copy (keep local), or edit either file until they match");
	}
	if (deletedRemotely.length > 0) {
		notes.push("Deleted on remote: the remote file was removed but a local copy was changed or could not be verified. The local file was kept and nothing was saved to _fit/");
	}

	// Explanatory notes for special local states
	if (savedToFit.some(c => c.localState === 'pending')) {
		notes.push("Pending: unresolved from a prior sync — will keep appearing and local changes won't sync until resolved");
	}
	if (clashedFiles.some(c => c.localState === 'untracked')) {
		notes.push("Untracked: Could not verify local state - check logs for details");
	}
	if (savedToFit.some(c => c.path.split('/').some(p => p.startsWith('.')))) {
		notes.push("Hidden file conflict: Obsidian won't show the _fit/ copy in its file explorer. Resolve on desktop using a file manager, or open the _fit/ folder directly.");
	}
	return notes;
}
