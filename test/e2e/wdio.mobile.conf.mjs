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

// In CI, appium is started externally before wdio to avoid tsx hooks propagating
// to the appium subprocess (wdio adds tsx to NODE_OPTIONS for .ts spec loading).
// When EXTERNAL_APPIUM=1, skip the appium service; connect to the already-running server.
const appiumService = process.env.EXTERNAL_APPIUM
	? []
	: [["appium", {
		args: { allowInsecure: "*:chromedriver_autodownload,*:adb_shell" },
	}]];

export const config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./**/*.e2e.ts'],
	maxInstances: 1,

	hostname: 'localhost',
	port: 4723, // must match --port in scripts/run-android-tests-ci.sh
	path: '/',

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
		...appiumService,
	],

	reporters: ['obsidian'],
	cacheDir: cacheDir,

	mochaOpts: {
		ui: 'bdd',
		timeout: 60000,
	},
};
