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
		pendingUntrackedPaths: [],
		fitAttributesWarning: null,
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

describe('renderExplanation', () => {
	describe('never-synced', () => {
		it('notice — no commit to link (also: the full RenderableExplanation shape)', () => {
			// The one full-object snapshot in this file — kept as a concrete reference for
			// the complete shape, since every other test below only asserts the field(s) it
			// actually cares about.
			expect(explain(snapshot({ lastFetchedCommitSha: null }), [])).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": null,
				  "fitAttributesNote": null,
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
			const result = explain(snapshot({ trackedFileCount: 5, lastFetchedCommitSha: 'abcdef1234567' }), []);
			expect(result).toEqual(expect.objectContaining({
				statusNote: 'All 5 files synced (commit abcdef1)',
				commitUrl: null,
			}));
		});

		it('notice — with commit URL appended', () => {
			const result = explain(
				snapshot({ trackedFileCount: 5, lastFetchedCommitSha: '2e39870bfd4e1715222800d62947222c76def787' }),
				[],
				{ commitUrl: COMMIT_URL },
			);
			expect(result).toEqual(expect.objectContaining({
				statusNote: 'All 5 files synced (commit 2e39870)',
				commitUrl: COMMIT_URL,
			}));
		});

		it('notice — singular file count', () => {
			const result = explain(snapshot({ trackedFileCount: 1, lastFetchedCommitSha: 'abcdef1234567' }), []);
			expect(result).toEqual(expect.objectContaining({ statusNote: 'All 1 file synced (commit abcdef1)' }));
		});
	});

	describe('scan error', () => {
		it('modal — with specific failed paths and commit URL', () => {
			const result = explain(
				snapshot(),
				null,
				{ scanFailedPaths: ['ItsASecret.md', 'locked/private.md'], commitUrl: COMMIT_URL },
			);
			expect(result).toEqual(expect.objectContaining({
				scanNote: "Couldn't read: ItsASecret.md, locked/private.md — local changes may be incomplete",
				commitUrl: COMMIT_URL,
			}));
		});

		it('modal — singular failed path', () => {
			const result = explain(snapshot(), null, { scanFailedPaths: ['secret.md'] });
			expect(result).toEqual(expect.objectContaining({
				scanNote: "Couldn't read: secret.md — local changes may be incomplete",
			}));
		});

		it('modal — no path details available', () => {
			const result = explain(snapshot(), null, { scanFailedPaths: [] });
			expect(result).toEqual(expect.objectContaining({
				scanNote: "Couldn't scan all files — local changes may be incomplete",
			}));
		});
	});

	describe('pending clashes', () => {
		it('modal — singular, with commit URL', () => {
			const result = explain(
				snapshot({ pendingClashes: ['inbox.md'] }),
				[],
				{ commitUrl: COMMIT_URL },
			);
			expect(result).toEqual(expect.objectContaining({
				commitUrl: COMMIT_URL,
				sections: [{
					heading: '1 conflicted file need resolution',
					description: 'Fit saved conflicting copies in _fit/. Review each file there, then delete or apply it, and sync again.',
					items: [{ cls: 'file-needs-resolution', detail: '_fit/inbox.md', path: 'inbox.md' }],
				}],
			}));
		});

		it('modal — plural', () => {
			const result = explain(snapshot({ pendingClashes: ['notes/journal.md', 'inbox.md'] }), []);
			expect(result).toEqual(expect.objectContaining({
				sections: [expect.objectContaining({ heading: '2 conflicted files need resolution' })],
			}));
		});
	});

	describe('oversized files', () => {
		it('modal — singular', () => {
			const result = explain(snapshot({ oversizedFilePaths: ['big-video.mp4'] }), []);
			expect(result).toEqual(expect.objectContaining({
				sections: [{
					heading: '1 file too large to push',
					description: "These files exceeded GitHub's file size limit and were skipped. They won't sync until reduced in size or removed.",
					items: [{ cls: 'file-push-skipped', path: 'big-video.mp4' }],
				}],
			}));
		});

		it('modal — plural', () => {
			const result = explain(snapshot({ oversizedFilePaths: ['big.pdf', 'huge.zip'] }), []);
			expect(result).toEqual(expect.objectContaining({
				sections: [expect.objectContaining({ heading: '2 files too large to push' })],
			}));
		});
	});

	describe('local changes', () => {
		it('modal — mixed change types', () => {
			const result = explain(
				snapshot(),
				changes(['new-note.md', 'ADDED'], ['edited.md', 'MODIFIED'], ['old.md', 'REMOVED']),
			);
			expect(result).toEqual(expect.objectContaining({
				sections: [{
					heading: '3 local changes pending next sync',
					description: 'These local edits will be pushed the next time you run Fit Sync.',
					items: [
						{ cls: 'file-ADDED', path: 'new-note.md' },
						{ cls: 'file-MODIFIED', path: 'edited.md' },
						{ cls: 'file-REMOVED', path: 'old.md' },
					],
				}],
			}));
		});

		it('modal — singular', () => {
			const result = explain(snapshot(), changes(['new.md', 'ADDED']));
			expect(result).toEqual(expect.objectContaining({
				sections: [expect.objectContaining({ heading: '1 local change pending next sync' })],
			}));
		});

		it('_fit/ paths excluded from local changes — never appear as pending sync', () => {
			// _fit/ files are clash copies, not independently syncable
			const result = explain(
				snapshot({ pendingClashes: ['file.md'] }),
				changes(['_fit/file.md', 'ADDED'], ['other.md', 'MODIFIED']),
			);
			const localChangesSection = (result.sections as { heading: string }[]).find(s => s.heading.includes('pending next sync'));
			expect(localChangesSection).toEqual(expect.objectContaining({
				items: [{ cls: 'file-MODIFIED', path: 'other.md' }],
			}));
		});

		it('_fit/ path with no clash entry still excluded', () => {
			// Even if _fit/ file appears without a matching pendingClash (stale state),
			// it must not surface as a pending local change
			const result = explain(
				snapshot(),
				changes(['_fit/orphan.md', 'ADDED'], ['clean.md', 'ADDED']),
			);
			expect(result).toEqual(expect.objectContaining({
				sections: [expect.objectContaining({ items: [{ cls: 'file-ADDED', path: 'clean.md' }] })],
			}));
		});

		it('clashes exclude those paths from local changes section', () => {
			const result = explain(
				snapshot({ pendingClashes: ['clashed.md'] }),
				changes(['clashed.md', 'MODIFIED'], ['clean.md', 'ADDED']),
			);
			const localChangesSection = (result.sections as { heading: string }[]).find(s => s.heading.includes('pending next sync'));
			expect(localChangesSection).toEqual(expect.objectContaining({
				items: [{ cls: 'file-ADDED', path: 'clean.md' }],
			}));
		});
	});

	describe('malformed .fitattributes.json', () => {
		it('reports issues, not ok, when only fitAttributesWarning is set', () => {
			const explanation = buildStatusExplanation(snapshot({ fitAttributesWarning: 'boom' }), []);
			expect(explanation).toEqual(expect.objectContaining({ kind: 'issues' }));
		});

		it('surfaces the warning text as fitAttributesNote', () => {
			const result = explain(snapshot({ fitAttributesWarning: 'boom' }), []);
			expect(result).toEqual(expect.objectContaining({ fitAttributesNote: 'boom' }));
		});

		it('does not surface a note when .fitattributes.json is valid or absent', () => {
			const result = explain(snapshot({ fitAttributesWarning: null }), []);
			expect(result).toEqual(expect.objectContaining({ fitAttributesNote: null }));
		});
	});

	describe('multiple issue types', () => {
		it('all three sections — order: clashes, oversized, local changes', () => {
			// Full structural snapshot kept deliberately here: this test exists specifically
			// to prove composition/ordering across all three section types together, which a
			// field-by-field assertion would obscure rather than clarify.
			expect(explain(
				snapshot({ pendingClashes: ['clash.md'], oversizedFilePaths: ['big.pdf'] }),
				changes(['new.md', 'ADDED']),
				{ commitUrl: COMMIT_URL },
			)).toMatchInlineSnapshot(`
				{
				  "autoSyncNote": null,
				  "commitUrl": "https://github.com/dbarnett/myvault/tree/2e39870bfd4e1715222800d62947222c76def787",
				  "fitAttributesNote": null,
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
			const result = renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info });
			expect(result).toEqual(expect.objectContaining({ autoSyncNote: 'Auto-sync: off' }));
		});

		it('ok notice — auto-sync on, never synced in session', () => {
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt: null, now: BASE_NOW };
			const result = renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info });
			expect(result).toEqual(expect.objectContaining({
				autoSyncNote: 'Auto-sync: every 30 min (never synced in this session)',
			}));
		});

		it('ok notice — auto-sync on, synced 3 min ago', () => {
			const lastSyncedAt = BASE_NOW - 3 * 60 * 1000;
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt, now: BASE_NOW };
			const result = renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info });
			expect(result).toEqual(expect.objectContaining({
				autoSyncNote: 'Auto-sync: every 30 min · last synced 3 min ago · next in ~27 min',
			}));
		});

		it('ok notice — synced just now (< 1 min)', () => {
			const lastSyncedAt = BASE_NOW - 45 * 1000;
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt, now: BASE_NOW };
			const result = renderExplanation({ kind: 'ok', fileCount: 3, shortSha: 'abcdef1' }, { autoSyncInfo: info });
			expect(result).toEqual(expect.objectContaining({
				autoSyncNote: 'Auto-sync: every 30 min · last synced just now · next in ~30 min',
			}));
		});

		it('issues modal — autoSyncNote included when auto-sync enabled', () => {
			const lastSyncedAt = BASE_NOW - 10 * 60 * 1000;
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 15, lastSyncedAt, now: BASE_NOW };
			const result = renderExplanation(
				buildStatusExplanation(BASE_SNAP, changes(['edit.md', 'MODIFIED']), undefined),
				{ autoSyncInfo: info },
			);
			expect(result).toEqual(expect.objectContaining({
				autoSyncNote: 'Auto-sync: every 15 min · last synced 10 min ago · next in ~5 min',
			}));
		});

		it('issues modal — autoSyncNote included when auto-sync off', () => {
			const info: AutoSyncInfo = { enabled: false, intervalMinutes: 30, lastSyncedAt: null, now: BASE_NOW };
			const result = renderExplanation(
				buildStatusExplanation(BASE_SNAP, changes(['edit.md', 'MODIFIED']), undefined),
				{ autoSyncInfo: info },
			);
			expect(result).toEqual(expect.objectContaining({ autoSyncNote: 'Auto-sync: off' }));
		});

		it('scan error modal — scanNote with autoSyncNote', () => {
			const info: AutoSyncInfo = { enabled: true, intervalMinutes: 30, lastSyncedAt: BASE_NOW - 5 * 60000, now: BASE_NOW };
			const result = renderExplanation(
				buildStatusExplanation(BASE_SNAP, null, ['ItsASecret.md']),
				{ autoSyncInfo: info },
			);
			expect(result).toEqual(expect.objectContaining({
				autoSyncNote: 'Auto-sync: every 30 min · last synced 5 min ago · next in ~25 min',
				scanNote: "Couldn't read: ItsASecret.md — local changes may be incomplete",
			}));
		});
	});
});
