import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import stylisticPlugin from '@stylistic/eslint-plugin';
import globals from 'globals';
import builtins from 'builtin-modules';

// Node built-ins, with and without the `node:` prefix. Obsidian mobile has no Node.js runtime.
const bareBuiltinNames = [...new Set(builtins.map(name => name.replace(/^node:/, '')))];
const nodeBuiltinModules = bareBuiltinNames.flatMap(name => [name, `node:${name}`]);
const nodeBuiltinMessage = 'Node.js built-ins do not exist on Obsidian mobile. Use Web APIs or Obsidian\'s API instead (docs/api-compatibility.md).';
// esquery regex source matching a module specifier that is a Node built-in. esquery cannot
// express a literal '/' inside a regex, so the slash of e.g. 'fs/promises' becomes '.'.
const nodeBuiltinSpecifier = `^(node:)?(${bareBuiltinNames.map(name => name.replace('/', '.')).join('|')})$`;

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
		//
		// To allow a Node built-in in one desktop-only file: add a block AFTER this one with
		// `files: ['src/that/file.ts']` that turns off no-restricted-imports (or lists only the
		// other modules), re-lists no-restricted-globals without `require`, and re-lists
		// no-restricted-syntax without the ImportExpression selector. Then allow the same file in
		// the bundle check in src/apiCompatibility.test.ts, and document it in
		// docs/api-compatibility.md ("Desktop-only exceptions"). Prefer a per-file block to an
		// inline eslint-disable, so the exception is reviewable in one place.
		files: ['src/**/*.ts'],
		ignores: ['src/**/*.test.ts', 'src/**/*.e2e.ts', 'src/__mocks__/**', 'src/testUtils.ts'],
		rules: {
			'no-restricted-globals': ['error',
				{ name: 'Buffer', message: 'Buffer is Node.js-only. Use TextEncoder/arrayBufferToBase64 instead.' },
				{ name: 'require', message: 'require() is Node.js-only. Use ES module imports.' },
				{ name: 'process', message: 'process is Node.js-only. Not available on Obsidian mobile.' },
			],
			'no-restricted-imports': ['error', {
				paths: nodeBuiltinModules.map(name => ({ name, message: nodeBuiltinMessage })),
			}],
			'no-restricted-syntax': ['error',
				{
					selector: `ImportExpression[source.value=/${nodeBuiltinSpecifier}/]`,
					message: nodeBuiltinMessage,
				},
				{
					selector: "NewExpression[callee.name='TextDecoder'][arguments.length < 2]",
					message: "Use new TextDecoder(encoding, { fatal: true }) to prevent silent data corruption on invalid UTF-8.",
				},
				{
					selector: "NewExpression[callee.name='TextDecoder'][arguments.length >= 2]:not(:has(ObjectExpression > Property[key.name='fatal'][value.value=true]))",
					message: "Pass { fatal: true } literally: any other TextDecoder options silently replace invalid UTF-8 with U+FFFD.",
				},
				{
					selector: "CallExpression[callee.object.name='String'][callee.property.name='fromCharCode'] > SpreadElement",
					message: "Spreading a large array into a call overflows the stack (limit ~128k arguments). Use Array.from(bytes, b => String.fromCharCode(b)).",
				},
				{
					selector: "CallExpression[callee.property.name=/^(read|cachedRead)$/]:matches([callee.object.name='vault'], [callee.object.property.name='vault'])",
					message: "vault.read()/cachedRead() can succeed on binary files and return corrupted text (#156). Use vault.readBinary(), or vault.adapter.read() for paths outside the index.",
				},
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
