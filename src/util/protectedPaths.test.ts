import { describe, it, expect } from 'vitest';
import { isHardDenylistedObsidianPath } from './protectedPaths';

describe('isHardDenylistedObsidianPath', () => {
	it.each([
		// FIT's own data.json is masked (format:"json" + scope:"subset" with a field
		// denylist, FIT_OWN_SETTINGS_DENYLIST, Fit.resolveSyncFormat/resolveScope), not
		// hard-denylisted.
		{ name: 'fit data.json (masked, not hard-denylisted)', path: '.obsidian/plugins/fit/data.json', expected: false },
		{ name: 'other plugin data.json', path: '.obsidian/plugins/other-plugin/data.json', expected: false },
		// FIT's own runtime assets are hard-denylisted to prevent execution corruption
		{ name: 'fit main.js', path: '.obsidian/plugins/fit/main.js', expected: true },
		{ name: 'fit manifest.json', path: '.obsidian/plugins/fit/manifest.json', expected: true },
		{ name: 'fit styles.css', path: '.obsidian/plugins/fit/styles.css', expected: true },
		{ name: 'fit debug.log', path: '.obsidian/plugins/fit/debug.log', expected: true },
		{ name: 'fit rotated debug.log.0', path: '.obsidian/plugins/fit/debug.log.0', expected: true },
		// Community plugin assets are now sync-eligible
		{ name: 'other plugin main.js', path: '.obsidian/plugins/some-plugin/main.js', expected: false },
		{ name: 'other plugin manifest.json', path: '.obsidian/plugins/some-plugin/manifest.json', expected: false },
		{ name: 'other plugin styles.css', path: '.obsidian/plugins/some-plugin/styles.css', expected: false },
		{ name: 'ordinary config file', path: '.obsidian/graph.json', expected: false },
		{ name: 'non-code file inside a plugin dir', path: '.obsidian/plugins/some-plugin/README.md', expected: false },
		// Workspace layout files are not hard-denylisted (configurable via .fitattributes.json if desired)
		{ name: 'workspace.json', path: '.obsidian/workspace.json', expected: false },
		{ name: 'workspace-mobile.json', path: '.obsidian/workspace-mobile.json', expected: false },
		{ name: 'cache dir file', path: '.obsidian/cache/index.json', expected: true },
		// Dependencies and VCS files in plugin directories
		{ name: 'node_modules file inside a plugin dir', path: '.obsidian/plugins/some-plugin/node_modules/foo/index.js', expected: true },
		{ name: 'node_modules dir itself inside a plugin dir', path: '.obsidian/plugins/some-plugin/node_modules', expected: false },
		{ name: 'git dir inside a plugin dir', path: '.obsidian/plugins/some-plugin/.git/config', expected: true },
		{ name: 'file merely named node_modules, not a directory', path: '.obsidian/plugins/some-plugin/node_modules.json', expected: false },
	])('$name → $expected', ({ path, expected }) => {
		expect(isHardDenylistedObsidianPath(path)).toBe(expected);
	});

	it('respects dynamic ownPluginDir', () => {
		expect(isHardDenylistedObsidianPath('.obsidian/plugins/fit-dev/main.js', '.obsidian/plugins/fit-dev')).toBe(true);
		expect(isHardDenylistedObsidianPath('.obsidian/plugins/fit/main.js', '.obsidian/plugins/fit-dev')).toBe(false);
	});
});
