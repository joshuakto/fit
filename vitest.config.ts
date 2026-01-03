import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src'),
			'@main': path.resolve(__dirname, 'main.ts'),
			'obsidian': path.resolve(__dirname, 'src/__mocks__/obsidian.ts'),
			'@octokit/core': path.resolve(__dirname, 'src/__mocks__/@octokit/core.ts'),
			'@octokit/plugin-retry': path.resolve(__dirname, 'src/__mocks__/@octokit/plugin-retry.ts'),
		},
	},
	test: {
		environment: 'happy-dom',
		setupFiles: ['./vitest.setup.ts'],
		include: ['src/**/*.test.ts'],
		testTimeout: 10000, // 10 second timeout per test (default is 5s)
		hookTimeout: 10000, // 10 second timeout for beforeAll/afterAll hooks
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'lcov', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/__mocks__/**'],
		},
	},
});
