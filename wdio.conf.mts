import * as path from "path";
import { obsidianBetaAvailable } from "wdio-obsidian-service";

const cacheDir = path.resolve(".obsidian-cache");

// Test on multiple Obsidian versions
const versions: [string, string][] = [
	["earliest", "earliest"], // minAppVersion from manifest.json
	["latest", "latest"],
];

// Add beta testing if credentials are available
if (await obsidianBetaAvailable(cacheDir)) {
	versions.push(["latest-beta", "latest"]);
}

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: 2, // Run up to 2 Obsidian instances in parallel

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
