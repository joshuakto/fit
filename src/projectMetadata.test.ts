/**
 * Consistency between package.json, manifest.json and versions.json. Add a cross-file rule here
 * as its own `describe` rather than a new file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');

function readJson(file: string): Record<string, any> {
	return JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8'));
}

/** Negative, zero or positive like a comparator, for plain `x.y.z` versions. */
function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

describe('obsidian API types version', () => {
	// The `obsidian` devDependency is only the API type definitions. Pinning it to the oldest
	// supported Obsidian makes the compiler reject newer APIs. Dependabot proposes latest.
	it('is pinned to manifest.json minAppVersion', () => {
		const typesRange: string = readJson('package.json').devDependencies.obsidian;
		const minAppVersion: string = readJson('manifest.json').minAppVersion;

		// "~1.11.4" -> "1.11.4": a patch-level range still resolves to the pinned minor.
		expect(
			typesRange.replace(/^~/, ''),
			`devDependencies.obsidian is "${typesRange}" but minAppVersion is "${minAppVersion}". ` +
			'Keep the obsidian types at minAppVersion and bump both together. If a security update ' +
			'for a dependency of obsidian (e.g. moment) prompted the bump, use "overrides" in ' +
			'package.json instead.'
		).toBe(minAppVersion);
	});
});

// https://docs.obsidian.md/Reference/Versions documents only a map of plugin version -> minAppVersion,
// used as a fallback when the user's app is older than manifest.json's minAppVersion. It does not
// require an entry per release or one for manifest.json's current version (release.sh adds that at
// release time), so these tests only catch what would make the file nonsense.
describe('versions.json', () => {
	const versions: Record<string, string> = readJson('versions.json');
	const manifest = readJson('manifest.json');
	const entries = Object.entries(versions).sort(([a], [b]) => compareVersions(a, b));

	it('maps plain x.y.z plugin versions to plain x.y.z app versions', () => {
		const malformed = entries.filter(([plugin, app]) => !PLAIN_VERSION.test(plugin) || !PLAIN_VERSION.test(app));
		expect(malformed).toEqual([]);
	});

	it('never lists a plugin version newer than manifest.json', () => {
		const ahead = entries.map(([plugin]) => plugin).filter(plugin => compareVersions(plugin, manifest.version) > 0);
		expect(ahead).toEqual([]);
	});

	// A newer plugin version never supports older apps than the one before it.
	it('has non-decreasing minAppVersion as plugin versions increase', () => {
		const decreases = entries.slice(1)
			.map(([plugin, app], i) => ({ plugin, app, previous: entries[i][1] }))
			.filter(({ app, previous }) => compareVersions(app, previous) < 0);
		expect(decreases).toEqual([]);
	});

	// Only an upper bound: after a minAppVersion bump on main and before the next release, the
	// current version's entry legitimately still has the old, lower value.
	it('never requires an app newer than manifest.json minAppVersion', () => {
		const ahead = entries.filter(([, app]) => compareVersions(app, manifest.minAppVersion) > 0);
		expect(ahead).toEqual([]);
	});
});
