/**
 * FIT Plugin E2E Tests
 *
 * End-to-end tests for the FIT (File gIT) Obsidian plugin using WebdriverIO
 * and wdio-obsidian-service to test in a real Obsidian environment.
 *
 * Test Environment:
 * - Real Obsidian instance (desktop, and the Android app via wdio.mobile.conf.mjs)
 * - Test vault: test/vaults/basic/
 * - Plugin loaded from current directory
 *
 * Validated Functionality:
 * - Plugin loads without crashing
 * - FIT sync command executes successfully
 * - Expected notices appear (config not set up)
 * - No error notices are generated
 * - PAT authentication populates the settings fields
 * - Screenshots capture test results
 *
 * Conventions (see ui-actions.ts and diagnostics.ts):
 * - Never wait a fixed time for UI: wait on a condition, with a timeout that only bounds failure.
 * - Notices are recorded in the page, not polled; they disappear faster than a slow driver can poll.
 *
 * Prerequisites:
 * - WebdriverIO and wdio-obsidian-service installed
 * - Test vault exists at test/vaults/basic/
 * - Plugin builds successfully (npm run build)
 */

import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { setupGitHubStub, cleanupGitHubStub } from './github-stub';
import { tagAllureRun, takeScreenshot } from './diagnostics';
import { openFitSettings, readSettingInput, startNoticeRecorder, waitForSettingInput } from './ui-actions';

describe('FIT Plugin E2E Tests', function() {
	this.timeout(60000); // 60 second timeout

	// Automatically screenshot on any test failure
	afterEach(async function() {
		if (this.currentTest?.state === 'failed') {
			try {
				await takeScreenshot(`FAILED-${this.currentTest.title.replace(/\s+/g, '-')}`);
			} catch (e) {
				console.log('Failed to take failure screenshot:', e);
			}
		}
	});

	describe('Core Functionality', function() {
		it('should run FIT sync and capture complete result', async () => {
			tagAllureRun();
			// Single comprehensive test covering plugin loading, sync execution, and screenshot capture

			// 1. Verify plugin loads (implicit test - if this runs, plugin loaded without crashing)
			console.log('📱 FIT plugin environment loaded successfully');

			// 2. Execute FIT sync command, recording notices from before it runs
			const recorder = await startNoticeRecorder();
			await browser.executeObsidianCommand("fit:fit-sync");

			// 3. Verify expected behavior; the screenshot is taken even if this times out
			let notices;
			try {
				notices = await recorder.waitFor('Settings not configured');
			} finally {
				await takeScreenshot('fit-sync-result');
			}
			console.log('Notices after sync:', notices);

			// 4. Assertions
			const errorNotices = notices.filter(n => n.classes.includes('notice-error'));
			const configNotice = notices.find(n =>
				n.text.includes('Settings not configured') &&
				n.text.includes('provide GitHub personal access token')
			);

			// Verify plugin works as expected
			expect(errorNotices).toHaveLength(0);
			expect(configNotice?.text).toContain('Settings not configured');
		});
	});

	describe('Settings UI', function() {
		beforeEach(async function() {
			// Setup GitHub API stub before each settings test
			await setupGitHubStub('ghp_test');
		});

		afterEach(async function() {
			// Clean up stub after each settings test
			await cleanupGitHubStub();
		});

		it('should authenticate with PAT and populate owner and repo fields', async () => {
			tagAllureRun();
			// Test PAT authentication flow with stubbed GitHub API
			// Verifies: PAT input → Authenticate → Owner populated → Repos fetched and displayed

			// 0. Store the token in Obsidian's secret storage and point FIT's settings at it
			// (the token is picked from there, not typed). Also checks the storage works at all.
			const storedToken = await browser.executeObsidian(async ({ app }) => {
				const fit = (app as any).plugins.plugins['fit'];
				app.secretStorage.setSecret('fit-e2e-token', 'ghp_test');
				fit.settings.patSecretName = 'fit-e2e-token';
				fit.settings.pat = app.secretStorage.getSecret('fit-e2e-token');
				await fit.saveSettings();
				return fit.settings.pat;
			});
			expect(storedToken).toBe('ghp_test');

			// 1. Open FIT's settings pane
			await openFitSettings();
			await takeScreenshot('settings-opened');

			// 2. Click Authenticate button
			const authButton = await browser.$('button*=Authenticate user');
			await authButton.click();

			// 3. Wait for authentication to complete: the GitHub API stub returns 'testowner'
			await waitForSettingInput('Repository owner', 'testowner');
			await takeScreenshot('settings-auth-success');

			// 4. Wait for the repo suggestions to be fetched (debounced). The repo input uses
			// AbstractInputSuggest, not datalist. The stub's fixtures give 'testowner' 2 repos.
			const getRepoOptions = () => browser.executeObsidian(() => {
				const settingsTab = (window as any).app?.setting?.pluginTabs?.find((tab: any) => tab.id === 'fit');
				return (settingsTab?.repoSuggest?.getSuggestions('') ?? []) as string[];
			});
			let repoOptions: string[] = [];
			await browser.waitUntil(
				async () => (repoOptions = await getRepoOptions()).length > 0,
				{ timeout: 15000, interval: 250, timeoutMsg: 'Repo suggestions were not populated' }
			);
			expect([...repoOptions].sort()).toEqual(['private-repo', 'testrepo']);

			// 5. Typing a partial match opens the suggestion popover (screenshottable, unlike a datalist)
			const repoInput = await browser.$('//div[contains(@class, "setting-item-name") and text()="Repository name"]/following::input[1]');
			await repoInput.click();
			await repoInput.setValue('test');
			await browser.waitUntil(
				() => browser.executeObsidian(() =>
					Array.from(document.querySelectorAll('.suggestion-item')).some(el => el.textContent?.includes('testrepo'))
				),
				{ timeout: 10000, timeoutMsg: 'testrepo suggestion did not appear in the popover' }
			);
			await takeScreenshot('repo-suggestions-visible');

			// 6. Select 'testrepo' from the suggestions by clicking on it
			await browser.executeObsidian(() => {
				const suggestion = Array.from(document.querySelectorAll('.suggestion-item'))
					.find(el => el.textContent?.includes('testrepo')) as HTMLElement | undefined;
				suggestion?.click();
			});

			// 7. The input holds the selected repo (read as a DOM property, like the owner field)
			await waitForSettingInput('Repository name', 'testrepo');
			expect(await readSettingInput('Repository name')).toBe('testrepo');
			await takeScreenshot('settings-repo-selected');
		});
	});

	beforeEach(async function() {
		// Clean up notices between tests
		await browser.executeObsidian(() => {
			const noticeContainer = document.querySelector('.notice-container');
			if (noticeContainer) {
				noticeContainer.innerHTML = '';
			}
		});
	});

	afterEach(async function() {
		// Clean up any open modals between tests
		await browser.executeObsidian(() => {
			const closeBtn = document.querySelector('.modal-container .modal-close-button');
			if (closeBtn) (closeBtn as any).click();
		});
		await obsidianPage.resetVault();
	});
});
