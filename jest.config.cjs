module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	extensionsToTreatAsEsm: ['.ts'],
	roots: ['<rootDir>/src'],
	testMatch: ['**/*.test.ts'],
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			useESM: true
		}],
		'^.+\\.js$': ['ts-jest', {
			useESM: true
		}]
	},
	transformIgnorePatterns: [
		'node_modules/(?!(@octokit|bottleneck)/)'
	],
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/**/*.test.ts',
		'!src/__mocks__/**',
	],
	coverageDirectory: 'coverage',
	coverageReporters: ['text', 'lcov', 'html'],
};
