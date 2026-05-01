/**
 * Tests for CliNotice
 *
 * Covers:
 * - ISyncNotice contract (setMessage, show, remove)
 * - Error vs. normal message formatting
 * - getLastMessage() tracking
 * - stderr output (no stdout contamination)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { CliNotice } from './cliNotice';

describe('CliNotice', () => {
	let stderrSpy: MockInstance<typeof process.stderr.write>;

	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	describe('setMessage', () => {
		it('should write a normal message to stderr with [FIT] prefix', () => {
			const notice = new CliNotice();
			notice.setMessage('Syncing...');
			expect(stderrSpy).toHaveBeenCalledWith('[FIT] Syncing...\n');
		});

		it('should write an error message to stderr with [FIT ERROR] prefix', () => {
			const notice = new CliNotice();
			notice.setMessage('Something went wrong', true);
			expect(stderrSpy).toHaveBeenCalledWith('[FIT ERROR] Something went wrong\n');
		});

		it('should update lastMessage on each call', () => {
			const notice = new CliNotice();
			notice.setMessage('first');
			notice.setMessage('second');
			expect(notice.getLastMessage()).toBe('second');
		});

		it('should not write to stdout', () => {
			const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
			const notice = new CliNotice();
			notice.setMessage('hello');
			expect(stdoutSpy).not.toHaveBeenCalled();
			stdoutSpy.mockRestore();
		});
	});

	describe('show', () => {
		it('should call setMessage when given an initial message', () => {
			const notice = new CliNotice();
			notice.show('Starting sync');
			expect(stderrSpy).toHaveBeenCalledWith('[FIT] Starting sync\n');
			expect(notice.getLastMessage()).toBe('Starting sync');
		});

		it('should be a no-op when called without a message', () => {
			const notice = new CliNotice();
			notice.show();
			expect(stderrSpy).not.toHaveBeenCalled();
			expect(notice.getLastMessage()).toBe('');
		});

		it('should ignore addClasses and duration parameters (CLI has no UI)', () => {
			const notice = new CliNotice();
			notice.show('msg', ['some-class'], 5000);
			expect(stderrSpy).toHaveBeenCalledWith('[FIT] msg\n');
		});
	});

	describe('remove', () => {
		it('should be a no-op (message already printed)', () => {
			const notice = new CliNotice();
			notice.setMessage('done');
			stderrSpy.mockClear();
			notice.remove('done', 5000);
			expect(stderrSpy).not.toHaveBeenCalled();
		});
	});

	describe('getLastMessage', () => {
		it('should return empty string before any message is set', () => {
			const notice = new CliNotice();
			expect(notice.getLastMessage()).toBe('');
		});

		it('should return the most recently set message', () => {
			const notice = new CliNotice();
			notice.setMessage('alpha');
			notice.setMessage('beta');
			expect(notice.getLastMessage()).toBe('beta');
		});

		it('should be updated by show()', () => {
			const notice = new CliNotice();
			notice.show('via show');
			expect(notice.getLastMessage()).toBe('via show');
		});
	});

	describe('ISyncNotice contract', () => {
		it('should implement all ISyncNotice methods', () => {
			const notice = new CliNotice();
			expect(typeof notice.setMessage).toBe('function');
			expect(typeof notice.show).toBe('function');
			expect(typeof notice.remove).toBe('function');
		});
	});
});
