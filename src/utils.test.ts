import { describe, it, expect } from 'vitest';
import { conflictNoticeNotes } from './utils';
import { FileClash } from './util/changeTracking';

const SAVED_TO_FIT_NOTES = [
	"Remote version saved to _fit/ — file held pending until resolved",
	"Resolve: delete _fit/ copy (keep local), or edit either file until they match",
];
const DELETED_REMOTELY_NOTE =
	"Deleted on remote: the remote file was removed but a local copy was changed or could not be verified. The local file was kept and nothing was saved to _fit/";
const HIDDEN_NOTE =
	"Hidden file conflict: Obsidian won't show the _fit/ copy in its file explorer. Resolve on desktop using a file manager, or open the _fit/ folder directly.";

const editedBothSides: FileClash = { path: 'note.md', localState: 'MODIFIED', remoteOp: 'MODIFIED' };
const editedLocallyDeletedRemotely: FileClash = { path: 'old.md', localState: 'MODIFIED', remoteOp: 'REMOVED' };

describe('conflictNoticeNotes', () => {
	it.each<[string, FileClash[], string[]]>([
		['clashes with a remote copy saved to _fit/', [editedBothSides], SAVED_TO_FIT_NOTES],
		['only clashes against a remote deletion', [editedLocallyDeletedRemotely], [DELETED_REMOTELY_NOTE]],
		[
			'both kinds of clash, so both can be resolved',
			[editedBothSides, editedLocallyDeletedRemotely],
			[...SAVED_TO_FIT_NOTES, DELETED_REMOTELY_NOTE],
		],
		[
			'a hidden path deleted remotely, which has no _fit/ copy to hide',
			[{ path: '.obsidian/app.json', localState: 'MODIFIED', remoteOp: 'REMOVED' }],
			[DELETED_REMOTELY_NOTE],
		],
		[
			'a hidden path with a _fit/ copy',
			[{ path: '.obsidian/app.json', localState: 'MODIFIED', remoteOp: 'MODIFIED' }],
			[...SAVED_TO_FIT_NOTES, HIDDEN_NOTE],
		],
	])('given %s, returns the matching footer notes', (_label, clashes, expected) => {
		expect(conflictNoticeNotes(clashes)).toEqual(expected);
	});
});
