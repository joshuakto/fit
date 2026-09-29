/**
 * Covers extractMask/overlayMask in isolation. Real sync behavior (push/pull/
 * clash wiring) is covered in src/fitSync.realFit.test.ts, not here.
 */
import { describe, it, expect } from 'vitest';
import { extractMask, overlayMask } from './protectedPathMask';

describe('extractMask', () => {
	it('projects only the tracked fields, dropping everything else', () => {
		const local = JSON.stringify({ theme: 'dark', accentColor: '#f00', windowWidth: 1200 });
		const result = extractMask(local, ['theme', 'accentColor']);
		expect(result).toEqual({ ok: true, value: { theme: 'dark', accentColor: '#f00' } });
	});

	it('omits a tracked field the local file does not have', () => {
		const local = JSON.stringify({ theme: 'dark' });
		const result = extractMask(local, ['theme', 'accentColor']);
		expect(result).toEqual({ ok: true, value: { theme: 'dark' } });
	});

	it('omits a tracked field name that collides with an inherited Object.prototype member the local file does not itself have', () => {
		// Regression test: this used to check `field in local.value`, which also sees
		// inherited properties (constructor, toString, ...) as "present" - a tracked field
		// literally named "constructor" would have read local's inherited Object
		// constructor function as if it were real tracked content, even with no such own
		// key in the actual local JSON.
		const local = JSON.stringify({ theme: 'dark' });
		const result = extractMask(local, ['theme', 'constructor', 'toString']);
		expect(result).toEqual({ ok: true, value: { theme: 'dark' } });
	});

	it('fails on unparseable local content', () => {
		expect(extractMask('not json', ['theme'])).toEqual(
			expect.objectContaining({ ok: false }),
		);
	});

	it('fails when local root is not an object', () => {
		expect(extractMask('[1,2,3]', ['theme'])).toEqual(
			expect.objectContaining({ ok: false }),
		);
	});
});

describe('overlayMask', () => {
	it('overwrites tracked keys, leaves other local keys untouched', () => {
		const local = JSON.stringify({ theme: 'light', windowWidth: 1200 });
		const result = overlayMask(local, { theme: 'dark' });
		expect(result).toEqual({ ok: true, value: { theme: 'dark', windowWidth: 1200 } });
	});

	it('adds a tracked key the local file did not have', () => {
		const local = JSON.stringify({ windowWidth: 1200 });
		const result = overlayMask(local, { theme: 'dark' });
		expect(result).toEqual({ ok: true, value: { windowWidth: 1200, theme: 'dark' } });
	});

	it('starts from an empty object when local content is null (first pull)', () => {
		const result = overlayMask(null, { theme: 'dark' });
		expect(result).toEqual({ ok: true, value: { theme: 'dark' } });
	});

	it('fails on unparseable local content', () => {
		expect(overlayMask('not json', { theme: 'dark' })).toEqual(
			expect.objectContaining({ ok: false }),
		);
	});
});
