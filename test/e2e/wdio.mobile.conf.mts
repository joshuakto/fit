import * as path from "path";

// Use this wdio configuration to test Obsidian against to real Obsidian Android app.
// Note: Beta versions require OBSIDIAN_EMAIL and OBSIDIAN_PASSWORD secrets for downloading.

const cacheDir = path.resolve("../../.obsidian-cache");

// Read Obsidian version from environment (for matrix testing latest vs earliest)
const obsidianVersion = process.env.OBSIDIAN_VERSIONS || "latest";

// Always output cache key for CI to use
console.log("obsidian-cache-key:", JSON.stringify({
	[obsidianVersion]: obsidianVersion
}));

export const config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./**/*.e2e.ts'],
	maxInstances: 1,

	// Real Android configuration
	capabilities: [{
		browserName: "obsidian",
		browserVersion: obsidianVersion,
		platformName: 'Android',
		'appium:automationName': 'UiAutomator2',
		'appium:avd': "obsidian_test",
		'appium:noReset': true, // wdio-obsidian-service will handle installing Obsidian
		'wdio:obsidianOptions': {
			plugins: ["../.."],
			vault: "../vaults/basic",
		},
	}],

	services: [
		"obsidian",
		["appium", {
			args: { allowInsecure: "chromedriver_autodownload:*,adb_shell:*" },
		}],
	],

	reporters: ['obsidian'],
	cacheDir: cacheDir,

	mochaOpts: {
		ui: 'bdd',
		timeout: 60000,
	},
};
