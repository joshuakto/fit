import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import stylisticPlugin from '@stylistic/eslint-plugin';
import globals from 'globals';

export default [
	{
		files: ['**/*.{js,ts}'],
		ignores: ['main.js', 'node_modules/**'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				sourceType: 'module',
			},
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
			'@stylistic': stylisticPlugin,
		},
		rules: {
			...js.configs.recommended.rules,
			...tsPlugin.configs.recommended.rules,

			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
			'@typescript-eslint/ban-ts-comment': 'off',
			'no-prototype-builtins': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'no-trailing-spaces': 'warn',
			'eol-last': 'warn',
			'@stylistic/no-mixed-spaces-and-tabs': ['warn'],
			'@stylistic/semi': ['warn', 'always'],
			'@stylistic/indent': ['warn', 'tab'],
			'no-redeclare': 'off',
			'no-control-regex': 'off',
		},
	},
	{
		// Ban Node.js-only globals in production source — Obsidian mobile has no Node.js runtime.
		// Test/config files are excluded since they legitimately run in Node.
		files: ['src/**/*.ts'],
		ignores: ['src/**/*.test.ts', 'src/**/*.e2e.ts', 'src/__mocks__/**', 'src/testUtils.ts'],
		rules: {
			'no-restricted-globals': ['error',
				{ name: 'Buffer', message: 'Buffer is Node.js-only. Use TextEncoder/arrayBufferToBase64 instead.' },
				{ name: 'require', message: 'require() is Node.js-only. Use ES module imports.' },
				{ name: 'process', message: 'process is Node.js-only. Not available on Obsidian mobile.' },
			],
		},
	},
	{
		// Test-related files: Allow 'any' type for mocking external libraries
		// Covers: test files, mock implementations, test utilities, and test setup
		files: ['**/*.test.ts', '**/__mocks__/**/*.ts', '**/testUtils.ts', '**/vitest.setup.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	{
		// E2E test files: Allow Mocha globals
		files: ['**/*.e2e.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				sourceType: 'module',
			},
			globals: {
				...globals.node,
				...globals.browser,
				// Mocha globals
				describe: 'readonly',
				it: 'readonly',
				before: 'readonly',
				after: 'readonly',
				beforeEach: 'readonly',
				afterEach: 'readonly',
				expect: 'readonly',
				// WebdriverIO globals
				browser: 'readonly',
				$: 'readonly',
				$$: 'readonly',
			},
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
];
