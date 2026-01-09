import * as path from "path";

const cacheDir = path.resolve(".obsidian-cache");

// Test on mobile (latest Obsidian version)
export const config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./test/e2e/**/*.e2e.ts'], // Run actual E2E tests
	maxInstances: 1,

	// Mobile emulation configuration
	capabilities: [{
		browserName: "obsidian",
		browserVersion: "latest",
		'wdio:obsidianOptions': {
			emulateMobile: true, // Enable mobile emulation
			plugins: ["."],
			vault: "test/vaults/basic",
		},
		'goog:chromeOptions': {
			mobileEmulation: {
				deviceMetrics: { width: 390, height: 844 }, // iPhone-like dimensions
			},
		},
	}],

	services: ['obsidian'],
	reporters: ['obsidian'],
	cacheDir: cacheDir,

	mochaOpts: {
		ui: 'bdd',
		timeout: 60000, // 60 second timeout
	},

	logLevel: "warn",
};