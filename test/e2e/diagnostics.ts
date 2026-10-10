/**
 * What a failed or slow E2E run leaves behind for debugging: screenshots, how results are grouped
 * in the Allure report, and a snapshot of the page. Used by desktop and Android runs alike.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { browser } from '@wdio/globals';
import allure from '@wdio/allure-reporter';
import * as fs from 'fs';

const OUTPUTS_PATH = 'test-results/';

export async function takeScreenshot(name: string) {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const screenshotPath = `${OUTPUTS_PATH}/${name}-${timestamp}.png`;

	if (!fs.existsSync(OUTPUTS_PATH)) {
		fs.mkdirSync(OUTPUTS_PATH, { recursive: true });
	}

	await browser.saveScreenshot(screenshotPath);
	console.log(`📸 Screenshot saved: ${screenshotPath}`);
}

// The combined Allure report merges every job's results. Without these parameters the same test
// from different jobs would be folded together as retries of one test, and the report's Suites tab
// would list them in one flat run. The parent suite groups results as "<platform> <version>".
export function tagAllureRun() {
	const platform = browser.isAndroid ? 'android' : 'desktop';
	const obsidian = browser.getObsidianVersion();
	allure.addArgument('platform', platform);
	allure.addArgument('obsidian', obsidian);
	allure.addParentSuite(`${platform} ${obsidian}`);
}

/**
 * Attach what the page looked like to the Allure report: what is on screen now, whether a
 * settings modal is open, FIT's configuration (secrets masked) and main-thread freezes seen by
 * the heartbeat that `startNoticeRecorder` runs. `extra` is attached alongside (e.g. the notices
 * recorded). Meant for diagnosing a failed expectation after the fact.
 */
export async function attachFailureSnapshot(extra?: Record<string, unknown>) {
	const snapshot = await browser.executeObsidian(({ app }) => {
		const a = app as any;
		const fit = a.plugins?.plugins?.fit;
		return {
			pageTimeMs: Math.round(performance.now()),
			heartbeatGaps: (window as any).__fitHeartbeatGaps ?? null,
			noticeContainers: Array.from(document.querySelectorAll('.notice-container')).map(c => ({
				display: getComputedStyle(c).display,
				notices: Array.from(c.querySelectorAll('.notice')).map(n => n.textContent?.trim() || ''),
			})),
			modalOpen: !!document.querySelector('.modal-container'),
			activeSettingsTab: a.setting?.activeTab?.id ?? null,
			fitSettings: fit ? {
				pat: fit.settings?.pat ? '<set>' : '',
				patSecretName: fit.settings?.patSecretName ?? null,
				owner: fit.settings?.owner,
				repo: fit.settings?.repo,
				branch: fit.settings?.branch,
			} : null,
		};
	});
	allure.addAttachment('failure-snapshot', JSON.stringify({ ...snapshot, ...extra }, null, 2), 'application/json');
}
