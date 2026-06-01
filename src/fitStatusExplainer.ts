import type { FileChange } from '@/util/changeTracking';

export interface SyncStatusSnapshot {
	lastFetchedCommitSha: string | null;
	trackedFileCount: number;
	pendingClashes: string[];
	oversizedFilePaths: string[];
}

export interface FileStatusItem {
	path: string;
	cls: string;        // CSS class applied to the li (file-ADDED, file-MODIFIED, file-REMOVED, file-needs-resolution, file-push-skipped)
	detail?: string;    // secondary label shown dim after path (e.g. "_fit/inbox.md" for conflicts)
}

export interface StatusSection {
	heading: string;
	description?: string;
	items: FileStatusItem[];
}

export interface AutoSyncInfo {
	enabled: boolean;
	intervalMinutes: number;
	lastSyncedAt: number | null;
	now?: number;  // injectable for tests
}

export type StatusExplanation =
	| { kind: 'never-synced' }
	| { kind: 'ok'; fileCount: number; shortSha: string }
	| { kind: 'issues'; sections: StatusSection[]; scanNote: string | null };

export interface RenderableExplanation {
	title: string;
	commitUrl: string | null;
	statusNote: string | null;   // summary line for never-synced / ok states
	autoSyncNote: string | null;
	sections: StatusSection[];
	scanNote: string | null;
}

const MODAL_TITLE = 'Fit Sync Status';

const CHANGE_CLS: Record<string, string> = {
	ADDED:    'file-ADDED',
	MODIFIED: 'file-MODIFIED',
	REMOVED:  'file-REMOVED',
};

export function buildStatusExplanation(
	snapshot: SyncStatusSnapshot,
	localChanges: FileChange[] | null,
	scanFailedPaths?: string[],
): StatusExplanation {
	if (!snapshot.lastFetchedCommitSha) {
		return { kind: 'never-synced' };
	}

	const { pendingClashes, oversizedFilePaths } = snapshot;
	const sections: StatusSection[] = [];

	let scanNote: string | null = null;
	if (localChanges === null) {
		if (scanFailedPaths && scanFailedPaths.length > 0) {
			const names = scanFailedPaths.join(', ');
			scanNote = `Couldn't read: ${names} — local changes may be incomplete`;
		} else {
			scanNote = "Couldn't scan all files — local changes may be incomplete";
		}
	}

	if (pendingClashes.length > 0) {
		const n = pendingClashes.length;
		const hasHiddenClashes = pendingClashes.some(p => p.split('/').some(part => part.startsWith('.')));
		const hiddenNote = hasHiddenClashes
			? ' Some conflicted files are hidden (start with .) — Obsidian won\'t show them in its file explorer. Use a desktop file manager to access the _fit/ copies.'
			: '';
		sections.push({
			heading: `${n} conflicted file${n === 1 ? '' : 's'} need resolution`,
			description: `Fit saved conflicting copies in _fit/. Review each file there, then delete or apply it, and sync again.${hiddenNote}`,
			items: pendingClashes.map(path => ({
				path,
				cls: 'file-needs-resolution',
				detail: `_fit/${path}`,
			})),
		});
	}

	if (oversizedFilePaths.length > 0) {
		const n = oversizedFilePaths.length;
		sections.push({
			heading: `${n} file${n === 1 ? '' : 's'} too large to push`,
			description: "These files exceeded GitHub's file size limit and were skipped. They won't sync until reduced in size or removed.",
			items: oversizedFilePaths.map(path => ({ path, cls: 'file-push-skipped' })),
		});
	}

	const blockedPaths = new Set([...pendingClashes, ...oversizedFilePaths]);
	const pendingLocalChanges = localChanges
		? localChanges.filter(c => !blockedPaths.has(c.path) && !c.path.startsWith('_fit/'))
		: null;

	if (pendingLocalChanges && pendingLocalChanges.length > 0) {
		const n = pendingLocalChanges.length;
		sections.push({
			heading: `${n} local change${n === 1 ? '' : 's'} pending next sync`,
			description: 'These local edits will be pushed the next time you run Fit Sync.',
			items: pendingLocalChanges.map(c => ({
				path: c.path,
				cls: CHANGE_CLS[c.type] ?? 'file-MODIFIED',
			})),
		});
	}

	if (sections.length === 0 && !scanNote) {
		return {
			kind: 'ok',
			fileCount: snapshot.trackedFileCount,
			shortSha: snapshot.lastFetchedCommitSha.slice(0, 7),
		};
	}

	return { kind: 'issues', sections, scanNote };
}

function formatAutoSyncNote(info: AutoSyncInfo): string {
	if (!info.enabled) return 'Auto-sync: off';

	const now = info.now ?? Date.now();
	const { intervalMinutes, lastSyncedAt } = info;

	if (lastSyncedAt === null) {
		return `Auto-sync: every ${intervalMinutes} min (never synced in this session)`;
	}

	const elapsedMs = now - lastSyncedAt;
	const elapsedMin = Math.floor(elapsedMs / 60000);
	const nextMin = intervalMinutes - (elapsedMin % intervalMinutes);

	const elapsed = elapsedMin < 1 ? 'just now' : `${elapsedMin} min ago`;
	return `Auto-sync: every ${intervalMinutes} min · last synced ${elapsed} · next in ~${nextMin} min`;
}

export function renderExplanation(
	explanation: StatusExplanation,
	opts: { commitUrl?: string | null; autoSyncInfo?: AutoSyncInfo } = {},
): RenderableExplanation {
	const { commitUrl = null, autoSyncInfo } = opts;
	const autoSyncNote = autoSyncInfo ? formatAutoSyncNote(autoSyncInfo) : null;

	switch (explanation.kind) {
		case 'never-synced':
			return {
				title: MODAL_TITLE,
				commitUrl: null,
				statusNote: 'Never synced — run Fit Sync to connect to your remote.',
				autoSyncNote,
				sections: [],
				scanNote: null,
			};

		case 'ok':
			return {
				title: MODAL_TITLE,
				commitUrl,
				statusNote: `All ${explanation.fileCount} file${explanation.fileCount === 1 ? '' : 's'} synced (commit ${explanation.shortSha})`,
				autoSyncNote,
				sections: [],
				scanNote: null,
			};

		case 'issues':
			return {
				title: MODAL_TITLE,
				commitUrl,
				statusNote: null,
				autoSyncNote,
				sections: explanation.sections,
				scanNote: explanation.scanNote,
			};
	}
}
