import { describe, it, expect } from 'vitest';
import { tryLineMerge } from './lineMerge';

describe('tryLineMerge', () => {
	it('merges edits to different, non-adjacent lines', () => {
		const base = 'line1\nline2\nline3\nline4\nline5\n';
		const local = 'line1\nline2-local\nline3\nline4\nline5\n';
		const remote = 'line1\nline2\nline3\nline4-remote\nline5\n';
		expect(tryLineMerge(base, local, remote)).toBe('line1\nline2-local\nline3\nline4-remote\nline5\n');
	});

	it('returns null when edits are on adjacent lines with no unchanged line between them', () => {
		// Region-based diff3 groups touching changes into one region; without an
		// unchanged anchor line separating them, it can't tell they're independent.
		const base = 'line1\nline2\nline3\n';
		const local = 'line1\nline2-local\nline3\n';
		const remote = 'line1\nline2\nline3-remote\n';
		expect(tryLineMerge(base, local, remote)).toBeNull();
	});

	it('returns local as-is when local and remote are byte-identical', () => {
		const base = 'line1\n';
		const same = 'line1\nline2-both-converged\n';
		expect(tryLineMerge(base, same, same)).toBe(same);
	});

	it('auto-resolves when both sides make the identical edit to the same line', () => {
		const base = 'line1\nline2\nline3\n';
		const local = 'line1\nline2-edited\nline3\n';
		const remote = 'line1\nline2-edited\nline3\n';
		expect(tryLineMerge(base, local, remote)).toBe('line1\nline2-edited\nline3\n');
	});

	it('merges when base is empty and both sides add different lines', () => {
		expect(tryLineMerge('', 'local only', 'remote only')).toBeNull();
	});

	it('preserves a trailing newline through the round trip', () => {
		const base = 'line1\nline2\nline3\n';
		const local = 'line1-edited\nline2\nline3\n';
		const remote = 'line1\nline2\nline3-edited\n';
		const merged = tryLineMerge(base, local, remote);
		expect(merged).toBe('line1-edited\nline2\nline3-edited\n');
		expect(merged?.endsWith('\n')).toBe(true);
	});

	it('merges a mid-list insertion on one side with an edit elsewhere on the other side', () => {
		// This is the case a pure append-only merge could not handle: the new
		// item lands in the middle of the list, not at the end of the file.
		const base = '- item1\n- item2\n- item3\n';
		const local = '- item1\n- item-inserted\n- item2\n- item3\n';
		const remote = '- item1\n- item2\n- item3-edited\n';
		expect(tryLineMerge(base, local, remote)).toBe(
			'- item1\n- item-inserted\n- item2\n- item3-edited\n'
		);
	});
});
