import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			'obsidian': path.resolve(__dirname, 'src/__mocks__/obsidian.ts'),
			'@octokit/core': path.resolve(__dirname, 'src/__mocks__/@octokit/core.ts'),
			'@octokit/plugin-retry': path.resolve(__dirname, 'src/__mocks__/@octokit/plugin-retry.ts'),
		},
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/__mocks__/**'],
		},
	},
});
