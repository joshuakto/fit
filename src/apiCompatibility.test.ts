/**
 * Mechanical checks for docs/api-compatibility.md: the rules that can be decided by a
 * linter or a bundler run, so they do not rely on code review noticing them.
 *
 * - ESLint rules: each unsafe snippet is linted with the repo's real eslint.config.js as if
 *   it lived in plugin source, and must be reported; the safe counterpart must not be.
 * - Bundle: the plugin entry point is bundled for a browser-like target with the same
 *   externals as the real build except Node built-ins, which cannot exist on mobile, so any
 *   (transitive) import of one fails the build.
 *
 * Not covered here: runtime behavior of the APIs (see contentEncoding.test.ts and
 * localVault.test.ts) and anything a static check cannot see.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { ESLint } from 'eslint';
import * as esbuild from 'esbuild';
import { obsidianExternals, nodeBuiltinNames } from '../esbuild.externals.mjs';

const repoRoot = path.resolve(__dirname, '..');

/** Rule ids ESLint reports for `code` linted as plugin source (`src/**` non-test code). */
async function lintPluginSource(code: string): Promise<string[]> {
	const eslint = new ESLint({ cwd: repoRoot });
	const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, 'src/probe.ts') });
	return result.messages
		.filter(m => m.ruleId === 'no-restricted-globals' || m.ruleId === 'no-restricted-syntax' || m.ruleId === 'no-restricted-imports')
		.map(m => `${m.ruleId}: ${m.message}`);
}

describe('mobile API compatibility: ESLint', () => {
	it.each([
		['the Buffer global', 'const b = Buffer.from("x");'],
		['the process global', 'const p = process.env.HOME;'],
		['require()', 'const fs = require("fs");'],
		['a static import of a Node built-in', 'import { readFile } from "fs";'],
		['a static import of a node:-prefixed built-in', 'import path from "node:path";'],
		['a dynamic import of a Node built-in', 'async function f() { return import("fs"); }'],
		['a TextDecoder without arguments', 'new TextDecoder().decode(bytes);'],
		['a TextDecoder without the fatal option', 'new TextDecoder("utf-8").decode(bytes);'],
		['a TextDecoder with fatal: false', 'new TextDecoder("utf-8", { fatal: false }).decode(bytes);'],
		['a TextDecoder with an empty options object', 'new TextDecoder("utf-8", {}).decode(bytes);'],
		['spreading a typed array into String.fromCharCode', 'String.fromCharCode(...new Uint8Array(buf));'],
		['vault.read() on a binary-capable file', 'async function f(vault, file) { return vault.read(file); }'],
		['this.app.vault.read() on a binary-capable file', 'class A { async f(file) { return this.app.vault.read(file); } }'],
	])('reports %s', async (_label, code) => {
		expect(await lintPluginSource(code)).not.toEqual([]);
	});

	it.each([
		['TextDecoder with fatal: true', 'new TextDecoder("utf-8", { fatal: true }).decode(bytes);'],
		['String.fromCharCode on single bytes', 'Array.from(bytes, b => String.fromCharCode(b)).join("");'],
		['vault.readBinary()', 'async function f(vault, file) { return vault.readBinary(file); }'],
		['adapter.read() for a path outside the index', 'async function f(vault) { return vault.adapter.read(".hidden"); }'],
		['a static import from a package', 'import { Notice } from "obsidian";'],
		['a dynamic import of a local module', 'async function f() { return import("./logger"); }'],
	])('allows %s', async (_label, code) => {
		expect(await lintPluginSource(code)).toEqual([]);
	});
});

const nodeBuiltins = new Set(nodeBuiltinNames);

/**
 * Fails resolution of any Node built-in, even one whose bare name is also an installed npm
 * package (`buffer`, `events`, `process`, `string_decoder`): without this, esbuild would bundle
 * the package for a browser target and hide an import the real build leaves as a bare
 * `require()`, which throws on mobile. To allow a desktop-only file (see eslint.config.js),
 * return `{ path: args.path, external: true }` here only when args.importer is that file, and
 * assert the built-ins left in the output are exactly the ones it may use.
 */
const rejectNodeBuiltins: esbuild.Plugin = {
	name: 'reject-node-builtins',
	setup(build) {
		build.onResolve({ filter: /^[^./]/ }, args => {
			if (!nodeBuiltins.has(args.path.replace(/^node:/, ''))) return undefined;
			return { errors: [{ text: `Node built-in "${args.path}" imported from ${args.importer}` }] };
		});
	},
};

/** Bundles for a browser-like target, with the real build's externals minus Node built-ins. */
async function bundleErrors(entry: esbuild.BuildOptions): Promise<string[]> {
	const result = await esbuild.build({
		...entry,
		bundle: true,
		write: false,
		format: 'cjs',
		target: 'es2018',
		logLevel: 'silent',
		external: obsidianExternals,
		platform: 'browser',
		plugins: [rejectNodeBuiltins],
	}).catch((error: esbuild.BuildFailure) => error);
	return 'errors' in result ? result.errors.map(e => e.text) : [];
}

describe('mobile API compatibility: bundle', () => {
	it('bundles the plugin without importing any Node built-in', async () => {
		expect(await bundleErrors({ entryPoints: [path.join(repoRoot, 'main.ts')] })).toEqual([]);
	}, 60000);

	it.each([
		['fs', 'import "fs";'],
		['a node: prefixed built-in', 'import "node:path";'],
		['a built-in subpath', 'import "fs/promises";'],
		['a built-in that is also an installed npm package', 'import "events";'],
	])('rejects a stray import of %s', async (_label, code) => {
		const errors = await bundleErrors({ stdin: { contents: code, resolveDir: repoRoot } });
		expect(errors).toEqual([expect.stringContaining('Node built-in')]);
	});

	it('allows a package whose name merely starts like a built-in', async () => {
		const errors = await bundleErrors({ stdin: { contents: 'import "events/";', resolveDir: repoRoot } });
		expect(errors).toEqual([]);
	});
});
