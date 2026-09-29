import { describe, it, expect } from 'vitest';
import { isHardDenylistedObsidianPath } from './protectedPaths';

describe('isHardDenylistedObsidianPath', () => {
	it.each([
		// FIT's own data.json is masked (format:"json" + scope:"subset" with a field
		// denylist, FIT_OWN_SETTINGS_DENYLIST, Fit.resolveSyncFormat/resolveScope), not
		// hard-denylisted. No install-dir-dependent branching left here to test — any
		// data.json path behaves the same.
		{ name: 'fit data.json (masked, not hard-denylisted)', path: '.obsidian/plugins/fit/data.json', expected: false },
		{ name: 'other plugin data.json', path: '.obsidian/plugins/other-plugin/data.json', expected: false },
		{ name: 'plugin main.js', path: '.obsidian/plugins/some-plugin/main.js', expected: true },
		{ name: 'plugin manifest.json', path: '.obsidian/plugins/some-plugin/manifest.json', expected: true },
		{ name: 'plugin styles.css', path: '.obsidian/plugins/some-plugin/styles.css', expected: true },
		{ name: 'ordinary config file', path: '.obsidian/graph.json', expected: false },
		{ name: 'non-code file inside a plugin dir', path: '.obsidian/plugins/some-plugin/README.md', expected: false },
		{ name: 'node_modules file inside a plugin dir', path: '.obsidian/plugins/some-plugin/node_modules/foo/index.js', expected: true },
		{ name: 'node_modules dir itself inside a plugin dir', path: '.obsidian/plugins/some-plugin/node_modules', expected: false },
		{ name: 'file merely named node_modules, not a directory', path: '.obsidian/plugins/some-plugin/node_modules.json', expected: false },
	])('$name → $expected', ({ path, expected }) => {
		expect(isHardDenylistedObsidianPath(path)).toBe(expected);
	});
});
