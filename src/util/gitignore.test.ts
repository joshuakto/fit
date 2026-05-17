/**
 * GitignoreFilter unit tests
 *
 * Covers pattern semantics, nested .gitignore scoping, knownPaths stat-skip optimization,
 * and the filter/ignores public API. Uses a mock adapter — no real filesystem or vault.
 * Integration with LocalVault (loading filters during readFromSource) is in localVault.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { GitignoreFilter } from './gitignore';

function mockAdapter(files: Record<string, string>) {
	return {
		stat: vi.fn().mockImplementation(async (path: string) =>
			path in files ? { type: 'file' } : null
		),
		read: vi.fn().mockImplementation(async (path: string) => {
			if (path in files) return files[path];
			throw new Error('File not found');
		})
	};
}

describe('GitignoreFilter.load', () => {
	it('returns an empty filter when no .gitignore files exist', async () => {
		const filter = await GitignoreFilter.load(mockAdapter({}) as any, ['README.md', 'src/main.ts']);
		expect(filter.isEmpty).toBe(true);
	});

	it('skips stat for paths in knownPaths', async () => {
		const adapter = mockAdapter({ '.gitignore': '*.log' });
		const knownPaths = new Set(['.gitignore']);

		await GitignoreFilter.load(adapter as any, ['a.log'], knownPaths);

		// stat should not have been called for .gitignore since it's in knownPaths
		expect(adapter.stat).not.toHaveBeenCalledWith('.gitignore');
		expect(adapter.read).toHaveBeenCalledWith('.gitignore');
	});

	it('falls back to stat for paths not in knownPaths', async () => {
		const adapter = mockAdapter({ '.gitignore': '*.log' });

		await GitignoreFilter.load(adapter as any, ['a.log']);

		expect(adapter.stat).toHaveBeenCalledWith('.gitignore');
	});
});

describe('GitignoreFilter.ignores', () => {
	it('returns false when filter is empty', async () => {
		const filter = await GitignoreFilter.load(mockAdapter({}) as any, []);
		expect(filter.ignores('anything.log')).toBe(false);
	});

	describe('root .gitignore patterns', () => {
		it.each([
			{ pattern: '*.log', path: 'debug.log', ignored: true },
			{ pattern: '*.log', path: 'nested/debug.log', ignored: true },
			{ pattern: '*.log', path: 'README.md', ignored: false },
			{ pattern: 'node_modules/', path: 'node_modules/pkg/index.js', ignored: true },
			{ pattern: '*.log\n!important.log', path: 'debug.log', ignored: true },
			{ pattern: '*.log\n!important.log', path: 'important.log', ignored: false },
			{ pattern: '# comment\n\n*.tmp', path: 'cache.tmp', ignored: true },
		])('pattern "$pattern" vs "$path" → ignored=$ignored', async ({ pattern, path, ignored }) => {
			const filter = await GitignoreFilter.load(
				mockAdapter({ '.gitignore': pattern }) as any,
				[path]
			);
			expect(filter.ignores(path)).toBe(ignored);
		});
	});

	describe('nested .gitignore scoping', () => {
		it('applies patterns relative to .gitignore location', async () => {
			const adapter = mockAdapter({ 'src/.gitignore': '*.generated.ts' });

			const filter = await GitignoreFilter.load(
				adapter as any,
				['src/file.generated.ts', 'src/nested/file.generated.ts', 'file.generated.ts']
			);

			expect(filter.ignores('src/file.generated.ts')).toBe(true);
			expect(filter.ignores('src/nested/file.generated.ts')).toBe(true);
			expect(filter.ignores('file.generated.ts')).toBe(false);
		});
	});
});

describe('GitignoreFilter.filter', () => {
	it('separates kept and ignored paths preserving order', async () => {
		const filter = await GitignoreFilter.load(
			mockAdapter({ '.gitignore': '*.log' }) as any,
			['c.md', 'a.log', 'b.md', 'd.log']
		);

		expect(filter.filter(['c.md', 'a.log', 'b.md', 'd.log'])).toEqual({
			kept: ['c.md', 'b.md'],
			ignored: ['a.log', 'd.log'],
		});
	});

	it('derives gitignore paths only from filePaths passed to load, not filter', async () => {
		// deriveGitignorePaths uses the filePaths from load() to know which
		// ancestor dirs to probe. If a nested .gitignore exists but no file
		// under that dir was passed to load(), the .gitignore won't be loaded.
		const adapter = mockAdapter({
			'.gitignore': '*.log',
			'deep/.gitignore': '*.md',
		});

		// Only root-level files passed to load — deep/.gitignore not probed
		const filter = await GitignoreFilter.load(adapter as any, ['a.log', 'b.md']);

		expect(filter.ignores('deep/note.md')).toBe(false); // deep/.gitignore wasn't loaded
		expect(filter.ignores('a.log')).toBe(true);         // root .gitignore applies
	});
});
