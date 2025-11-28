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
		// Test-related files: Allow 'any' type for mocking external libraries
		// Covers: test files, mock implementations, and test utilities
		files: ['**/*.test.ts', '**/__mocks__/**/*.ts', '**/testUtils.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
];
