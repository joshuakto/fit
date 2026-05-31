import { describe, it, expect } from 'vitest';
import { buildStatusExplanation, renderExplanation, type SyncStatusSnapshot, type AutoSyncInfo } from '@/fitStatusExplainer';
import type { FileChange } from '@/util/changeTracking';

// ─── helpers ─────────────────────────────────────────────────────────────────

function snapshot(overrides: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
	return {
		lastFetchedCommitSha: 'abc1234567890',
		trackedFileCount: 3,
		pendingClashes: [],
		oversizedFilePaths: [],
		...overrides,
	};
}

function changes(...specs: Array<[string, FileChange['type']]>): FileChange[] {
	return specs.map(([path, type]) => ({ path, type }));
}

const COMMIT_URL = 'https://github.com/dbarnett/myvault/tree/2e39870bfd4e1715222800d62947222c76def787';

// Convenience: build explanation then render it in one step
function explain(
	snap: SyncStatusSnapshot,
	localChanges: FileChange[] | null,
	opts: { scanFailedPaths?: string[]; commitUrl?: string | null } = {},
) {
	return renderExplanation(
		buildStatusExplanation(snap, localChanges, opts.scanFailedPaths),
		{ commitUrl: opts.commitUrl },
	);
}

// ─── renderExplanation snapshot tests ────────────────────────────────────────

describe('renderExplanation', () => {
	describe('never-synced', () => {
		it('notice — no commit to link', () => {
			expect(explain(snapshot({ lastFetchedCommitSha: null }), [])).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [],
				  "statusNote": "Never synced — run Fit Sync to connect to your remote.",
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

	describe('all synced (ok)', () => {
		it('notice — without commit URL', () => {
			expect(explain(snapshot({ trackedFileCount: 5, lastFetchedCommitSha: 'abcdef1234567' }), [])).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [],
				  "statusNote": "All 5 files synced (commit abcdef1)",
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('notice — with commit URL appended', () => {
			expect(explain(
				snapshot({ trackedFileCount: 5, lastFetchedCommitSha: '2e39870bfd4e1715222800d62947222c76def787' }),
				[],
				{ commitUrl: COMMIT_URL },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": "https://github.com/dbarnett/myvault/tree/2e39870bfd4e1715222800d62947222c76def787",
				  "scanNote": null,
				  "sections": [],
				  "statusNote": "All 5 files synced (commit 2e39870)",
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('notice — singular file count', () => {
			expect(explain(snapshot({ trackedFileCount: 1, lastFetchedCommitSha: 'abcdef1234567' }), [])).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [],
				  "statusNote": "All 1 file synced (commit abcdef1)",
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

	describe('scan error', () => {
		it('modal — with specific failed paths and commit URL', () => {
			expect(explain(
				snapshot(),
				null,
				{ scanFailedPaths: ['ItsASecret.md', 'locked/private.md'], commitUrl: COMMIT_URL },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": "https://github.com/dbarnett/myvault/tree/2e39870bfd4e1715222800d62947222c76def787",
				  "scanNote": "Couldn't read: ItsASecret.md, locked/private.md — local changes may be incomplete",
				  "sections": [],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('modal — singular failed path', () => {
			expect(explain(snapshot(), null, { scanFailedPaths: ['secret.md'] })).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": "Couldn't read: secret.md — local changes may be incomplete",
				  "sections": [],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('modal — no path details available', () => {
			expect(explain(snapshot(), null, { scanFailedPaths: [] })).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": "Couldn't scan all files — local changes may be incomplete",
				  "sections": [],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

	describe('pending clashes', () => {
		it('modal — singular, with commit URL', () => {
			expect(explain(
				snapshot({ pendingClashes: ['inbox.md'] }),
				[],
				{ commitUrl: COMMIT_URL },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": "https://github.com/dbarnett/myvault/tree/2e39870bfd4e1715222800d62947222c76def787",
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "Fit saved conflicting copies in _fit/. Review each file there, then delete or apply it, and sync again.",
				      "heading": "1 conflicted file need resolution",
				      "items": [
				        {
				          "cls": "file-needs-resolution",
				          "detail": "_fit/inbox.md",
				          "path": "inbox.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('modal — plural', () => {
			expect(explain(snapshot({ pendingClashes: ['notes/journal.md', 'inbox.md'] }), [])).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "Fit saved conflicting copies in _fit/. Review each file there, then delete or apply it, and sync again.",
				      "heading": "2 conflicted files need resolution",
				      "items": [
				        {
				          "cls": "file-needs-resolution",
				          "detail": "_fit/notes/journal.md",
				          "path": "notes/journal.md",
				        },
				        {
				          "cls": "file-needs-resolution",
				          "detail": "_fit/inbox.md",
				          "path": "inbox.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

	describe('oversized files', () => {
		it('modal — singular', () => {
			expect(explain(snapshot({ oversizedFilePaths: ['big-video.mp4'] }), [])).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "These files exceeded GitHub's file size limit and were skipped. They won't sync until reduced in size or removed.",
				      "heading": "1 file too large to push",
				      "items": [
				        {
				          "cls": "file-push-skipped",
				          "path": "big-video.mp4",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('modal — plural', () => {
			expect(explain(snapshot({ oversizedFilePaths: ['big.pdf', 'huge.zip'] }), [])).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "These files exceeded GitHub's file size limit and were skipped. They won't sync until reduced in size or removed.",
				      "heading": "2 files too large to push",
				      "items": [
				        {
				          "cls": "file-push-skipped",
				          "path": "big.pdf",
				        },
				        {
				          "cls": "file-push-skipped",
				          "path": "huge.zip",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

	describe('local changes', () => {
		it('modal — mixed change types', () => {
			expect(explain(
				snapshot(),
				changes(['new-note.md', 'ADDED'], ['edited.md', 'MODIFIED'], ['old.md', 'REMOVED']),
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "3 local changes pending next sync",
				      "items": [
				        {
				          "cls": "file-ADDED",
				          "path": "new-note.md",
				        },
				        {
				          "cls": "file-MODIFIED",
				          "path": "edited.md",
				        },
				        {
				          "cls": "file-REMOVED",
				          "path": "old.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('modal — singular', () => {
			expect(explain(snapshot(), changes(['new.md', 'ADDED']))).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "1 local change pending next sync",
				      "items": [
				        {
				          "cls": "file-ADDED",
				          "path": "new.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('_fit/ paths excluded from local changes — never appear as pending sync', () => {
			// _fit/ files are clash copies, not independently syncable
			expect(explain(
				snapshot({ pendingClashes: ['file.md'] }),
				changes(['_fit/file.md', 'ADDED'], ['other.md', 'MODIFIED']),
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "Fit saved conflicting copies in _fit/. Review each file there, then delete or apply it, and sync again.",
				      "heading": "1 conflicted file need resolution",
				      "items": [
				        {
				          "cls": "file-needs-resolution",
				          "detail": "_fit/file.md",
				          "path": "file.md",
				        },
				      ],
				    },
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "1 local change pending next sync",
				      "items": [
				        {
				          "cls": "file-MODIFIED",
				          "path": "other.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('_fit/ path with no clash entry still excluded', () => {
			// Even if _fit/ file appears without a matching pendingClash (stale state),
			// it must not surface as a pending local change
			expect(explain(
				snapshot(),
				changes(['_fit/orphan.md', 'ADDED'], ['clean.md', 'ADDED']),
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "1 local change pending next sync",
				      "items": [
				        {
				          "cls": "file-ADDED",
				          "path": "clean.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('clashes exclude those paths from local changes section', () => {
			expect(explain(
				snapshot({ pendingClashes: ['clashed.md'] }),
				changes(['clashed.md', 'MODIFIED'], ['clean.md', 'ADDED']),
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "Fit saved conflicting copies in _fit/. Review each file there, then delete or apply it, and sync again.",
				      "heading": "1 conflicted file need resolution",
				      "items": [
				        {
				          "cls": "file-needs-resolution",
				          "detail": "_fit/clashed.md",
				          "path": "clashed.md",
				        },
				      ],
				    },
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "1 local change pending next sync",
				      "items": [
				        {
				          "cls": "file-ADDED",
				          "path": "clean.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

	describe('multiple issue types', () => {
		it('all three sections — order: clashes, oversized, local changes', () => {
			expect(explain(
				snapshot({ pendingClashes: ['clash.md'], oversizedFilePaths: ['big.pdf'] }),
				changes(['new.md', 'ADDED']),
				{ commitUrl: COMMIT_URL },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": "https://github.com/dbarnett/myvault/tree/2e39870bfd4e1715222800d62947222c76def787",
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "Fit saved conflicting copies in _fit/. Review each file there, then delete or apply it, and sync again.",
				      "heading": "1 conflicted file need resolution",
				      "items": [
				        {
				          "cls": "file-needs-resolution",
				          "detail": "_fit/clash.md",
				          "path": "clash.md",
				        },
				      ],
				    },
				    {
				      "description": "These files exceeded GitHub's file size limit and were skipped. They won't sync until reduced in size or removed.",
				      "heading": "1 file too large to push",
				      "items": [
				        {
				          "cls": "file-push-skipped",
				          "path": "big.pdf",
				        },
				      ],
				    },
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "1 local change pending next sync",
				      "items": [
				        {
				          "cls": "file-ADDED",
				          "path": "new.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

	describe('auto-sync timing', () => {
		const BASE_NOW = 1748700000000; // fixed reference timestamp
		const BASE_SNAP = snapshot({ trackedFileCount: 3, lastFetchedCommitSha: 'abcdef1234567' });

		it('ok notice — auto-sync off, no note appended', () => {
			const info: AutoSyncInfo = { enabled: false, intervalMinutes: 30, lastSyncedAt: null, now: BASE_NOW };
			expect(renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info }))
				.toMatchInlineSnapshot(`
					{
					  "autoSyncNote": "Auto-sync: off",
					  "commitUrl": null,
					  "scanNote": null,
					  "sections": [],
					  "statusNote": "All 3 files synced (commit abcdef1)",
					  "title": "Fit Sync Status",
					}
				`);
		});

		it('ok notice — auto-sync on, never synced in session', () => {
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt: null, now: BASE_NOW };
			expect(renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info }))
				.toMatchInlineSnapshot(`
					{
					  "autoSyncNote": "Auto-sync: every 30 min (never synced in this session)",
					  "commitUrl": null,
					  "scanNote": null,
					  "sections": [],
					  "statusNote": "All 3 files synced (commit abcdef1)",
					  "title": "Fit Sync Status",
					}
				`);
		});

		it('ok notice — auto-sync on, synced 3 min ago', () => {
			const lastSyncedAt = BASE_NOW - 3 * 60 * 1000;
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt, now: BASE_NOW };
			expect(renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info }))
				.toMatchInlineSnapshot(`
					{
					  "autoSyncNote": "Auto-sync: every 30 min · last synced 3 min ago · next in ~27 min",
					  "commitUrl": null,
					  "scanNote": null,
					  "sections": [],
					  "statusNote": "All 3 files synced (commit abcdef1)",
					  "title": "Fit Sync Status",
					}
				`);
		});

		it('ok notice — synced just now (< 1 min)', () => {
			const lastSyncedAt = BASE_NOW - 45 * 1000;
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt, now: BASE_NOW };
			expect(renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info }))
				.toMatchInlineSnapshot(`
					{
					  "autoSyncNote": "Auto-sync: every 30 min · last synced just now · next in ~30 min",
					  "commitUrl": null,
					  "scanNote": null,
					  "sections": [],
					  "statusNote": "All 3 files synced (commit abcdef1)",
					  "title": "Fit Sync Status",
					}
				`);
		});

		it('issues modal — autoSyncNote included when auto-sync enabled', () => {
			const lastSyncedAt = BASE_NOW - 10 * 60 * 1000;
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 15, lastSyncedAt, now: BASE_NOW };
			expect(renderExplanation(
				buildStatusExplanation(BASE_SNAP, changes(['edit.md', 'MODIFIED']), undefined),
				{ autoSyncInfo: info },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": "Auto-sync: every 15 min · last synced 10 min ago · next in ~5 min",
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "1 local change pending next sync",
				      "items": [
				        {
				          "cls": "file-MODIFIED",
				          "path": "edit.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('issues modal — autoSyncNote included when auto-sync off', () => {
			const info: AutoSyncInfo = { enabled: false, intervalMinutes: 30, lastSyncedAt: null, now: BASE_NOW };
			expect(renderExplanation(
				buildStatusExplanation(BASE_SNAP, changes(['edit.md', 'MODIFIED']), undefined),
				{ autoSyncInfo: info },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": "Auto-sync: off",
				  "commitUrl": null,
				  "scanNote": null,
				  "sections": [
				    {
				      "description": "These local edits will be pushed the next time you run Fit Sync.",
				      "heading": "1 local change pending next sync",
				      "items": [
				        {
				          "cls": "file-MODIFIED",
				          "path": "edit.md",
				        },
				      ],
				    },
				  ],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});

		it('scan error modal — scanNote with autoSyncNote', () => {
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt: BASE_NOW - 5 * 60000, now: BASE_NOW };
			expect(renderExplanation(
				buildStatusExplanation(BASE_SNAP, null, ['ItsASecret.md']),
				{ autoSyncInfo: info },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": "Auto-sync: every 30 min · last synced 5 min ago · next in ~25 min",
				  "commitUrl": null,
				  "scanNote": "Couldn't read: ItsASecret.md — local changes may be incomplete",
				  "sections": [],
				  "statusNote": null,
				  "title": "Fit Sync Status",
				}
			`);
		});
	});

});

