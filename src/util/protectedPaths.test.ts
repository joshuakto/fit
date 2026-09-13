import { describe, it, expect } from 'vitest';
import { isHardDenylistedObsidianPath } from './protectedPaths';

describe('isHardDenylistedObsidianPath', () => {
	it.each([
		{ name: 'standard fit data.json', path: '.obsidian/plugins/fit/data.json', ownDataPath: null, expected: true },
		{ name: 'dynamic own data.json (alternate install dir)', path: '.obsidian/plugins/fit-dev/data.json', ownDataPath: '.obsidian/plugins/fit-dev/data.json', expected: true },
		{ name: 'plugin main.js', path: '.obsidian/plugins/some-plugin/main.js', ownDataPath: null, expected: true },
		{ name: 'plugin manifest.json', path: '.obsidian/plugins/some-plugin/manifest.json', ownDataPath: null, expected: true },
		{ name: 'plugin styles.css', path: '.obsidian/plugins/some-plugin/styles.css', ownDataPath: null, expected: true },
		{ name: 'ordinary config file', path: '.obsidian/graph.json', ownDataPath: null, expected: false },
		{ name: 'other plugin data.json (not own, not fit)', path: '.obsidian/plugins/other-plugin/data.json', ownDataPath: '.obsidian/plugins/fit-dev/data.json', expected: false },
		{ name: 'non-code file inside a plugin dir', path: '.obsidian/plugins/some-plugin/README.md', ownDataPath: null, expected: false },
	])('$name → $expected', ({ path, ownDataPath, expected }) => {
		expect(isHardDenylistedObsidianPath(path, ownDataPath)).toBe(expected);
	});
});
