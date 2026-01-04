import * as path from "path";
import { obsidianBetaAvailable } from "wdio-obsidian-service";

const cacheDir = path.resolve(".obsidian-cache");

// Test on single Obsidian version to prevent interference
const versions: [string, string][] = [
	["latest", "latest"], // Test only latest version
];

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: 1, // Run 1 instance to prevent test interference

	// Test on different Obsidian versions
	capabilities: versions.map(([appVersion, installerVersion]) => ({
		browserName: 'obsidian',
		browserVersion: appVersion,
		'wdio:obsidianOptions': {
			installerVersion: installerVersion,
			plugins: ["."], // Load this plugin
			vault: "test/vaults/basic", // Use a basic test vault
		},
	})),

	services: ['obsidian'],
	reporters: ['obsidian'],
	cacheDir: cacheDir,

	mochaOpts: {
		ui: 'bdd',
		timeout: 60000, // 60 second timeout for tests
	},

	logLevel: "warn",
};
