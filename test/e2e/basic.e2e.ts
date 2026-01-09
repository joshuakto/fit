/**
 * FIT Plugin E2E Tests
 *
 * End-to-end tests for the FIT (File gIT) Obsidian plugin using WebdriverIO
 * and wdio-obsidian-service to test in a real Obsidian environment.
 *
 * Test Environment:
 * - Real Obsidian instance (latest version)
 * - Test vault: test/vaults/basic/
 * - Plugin loaded from current directory
 *
 * Validated Functionality:
 * - Plugin loads without crashing
 * - FIT sync command executes successfully
 * - Expected notices appear (config not set up)
 * - No error notices are generated
 * - Screenshots capture test results
 *
 * Prerequisites:
 * - WebdriverIO and wdio-obsidian-service installed
 * - Test vault exists at test/vaults/basic/
 * - Plugin builds successfully (npm run build)
 */

import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import * as fs from 'fs';
import { setupGitHubStub, cleanupGitHubStub } from './github-stub';

const OUTPUTS_PATH = 'test-results/';

async function takeScreenshot(name: string) {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const screenshotPath = `${OUTPUTS_PATH}/${name}-${timestamp}.png`;

	// Ensure test-results directory exists
	if (!fs.existsSync(OUTPUTS_PATH)) {
		fs.mkdirSync(OUTPUTS_PATH, { recursive: true });
	}

	// Take screenshot showing the result
	await browser.saveScreenshot(screenshotPath);
	console.log(`📸 Screenshot saved: ${screenshotPath}`);
}

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
			// Single comprehensive test covering plugin loading, sync execution, and screenshot capture

			// 1. Verify plugin loads (implicit test - if this runs, plugin loaded without crashing)
			console.log('📱 FIT plugin environment loaded successfully');

			// 2. Execute FIT sync command
			await browser.executeObsidianCommand("fit:fit-sync");

			// 3. Give a moment for notices to appear
			await browser.pause(1000);

			// 4. Capture screenshot with timestamp
			await takeScreenshot('fit-sync-result');

			// 5. Verify expected behavior (config notice, no errors)
			const notices = await browser.executeObsidian(() => {
				const noticeContainer = document.querySelector('.notice-container');
				if (!noticeContainer) return [];

				const notices = Array.from(noticeContainer.querySelectorAll('.notice'));
				return notices.map(notice => ({
					text: notice.textContent?.trim() || '',
					type: notice.className || ''
				}));
			});

			console.log('Notices after sync:', notices);

			// 6. Assertions
			const errorNotices = notices.filter((n: any) => n.type.includes('notice-error'));
			const configNotice = notices.find((n: any) =>
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
			// Test PAT authentication flow with stubbed GitHub API
			// Verifies: PAT input → Authenticate → Owner populated → Repos fetched and displayed

			// 1. Open Obsidian settings
			await browser.executeObsidianCommand('app:open-settings');
			await browser.pause(500);

			// Take screenshot of settings page before trying to find FIT tab
			await takeScreenshot('settings-opened');

			// 2. Navigate to FIT plugin settings
			const fitTabFound = await browser.executeObsidian(() => {
				// Find FIT tab in settings sidebar (case-insensitive search)
				const fitTab = Array.from(document.querySelectorAll('.vertical-tab-nav-item'))
					.find(el => el.textContent?.toLowerCase().includes('fit'));
				if (fitTab) {
					(fitTab as HTMLElement).click();
					return true;
				}
				return false;
			});

			if (!fitTabFound) {
				await takeScreenshot('fit-tab-not-found');
				throw new Error('FIT plugin settings tab not found - is the plugin loaded?');
			}

			await browser.pause(500);

			// 3. Wait for settings UI to render and enter test PAT
			const patInput = await browser.$('input[placeholder*="personal access token"]');
			await patInput.waitForExist({ timeout: 5000 }); // Wait up to 5s for input to appear
			await patInput.setValue('ghp_test');
			await browser.pause(200); // Allow settings to update

			// 4. Click Authenticate button
			const authButton = await browser.$('button*=Authenticate user');
			await authButton.click();

			// 5. Wait for authentication to complete
			// GitHub API stub will return 'testowner' user
			await browser.pause(500);

			// 6. Verify owner field populated with stubbed user
			// Find input by the Repository owner label
			const ownerInput = await browser.$('//div[contains(@class, "setting-item-name") and text()="Repository owner"]/following::input[1]');
			const ownerValue = await ownerInput.getValue();
			const ownerAttribute = await ownerInput.getAttribute('value');
			const ownerProperty = await browser.executeObsidian(() => {
				// Find the owner input by its setting label
				const settingItems = Array.from(document.querySelectorAll('.setting-item'));
				const ownerSetting = settingItems.find(item =>
					item.querySelector('.setting-item-name')?.textContent === 'Repository owner'
				);
				const input = ownerSetting?.querySelector('input') as HTMLInputElement;
				return input?.value || null;
			});

			// Use whichever method actually returns a value
			const actualOwnerValue = ownerProperty || ownerAttribute || ownerValue;
			expect(actualOwnerValue).toBe('testowner');

			// 7. Take screenshot of authenticated state
			await takeScreenshot('settings-auth-success');

			// 8. Wait for repo dropdown to populate (debounced fetch)
			await browser.pause(800);

			// 9. Focus on repo input (now uses AbstractInputSuggest, not datalist)
			const repoInput = await browser.$('//div[contains(@class, "setting-item-name") and text()="Repository name"]/following::input[1]');

			// 10. Click to focus
			await repoInput.click();
			await browser.pause(200);

			// 11. Verify repo suggestions are populated (via AbstractInputSuggest)
			const repoOptions = await browser.executeObsidian(() => {
				// Access the FitSettingTab instance to get suggestions
				const settingsTab = (window as any).app?.setting?.pluginTabs?.find((tab: any) => tab.id === 'fit');
				if (!settingsTab?.repoSuggest) return [];
				return settingsTab.repoSuggest.getSuggestions('');
			});

			// Should have 2 repos for 'testowner' (from fixtures: testrepo, private-repo)
			expect(repoOptions.sort()).toEqual(['private-repo', 'testrepo']);

			// 12. Trigger the AbstractInputSuggest popover by typing
			// This should open the suggestion list that we can screenshot
			await repoInput.click();
			await repoInput.setValue('test'); // Type partial match to trigger suggestions
			await browser.pause(300); // Wait for suggestion popover to appear

			// 13. Take screenshot showing the suggestion popover
			// (Unlike datalists, AbstractInputSuggest popovers ARE visible and screenshottable!)
			await takeScreenshot('repo-suggestions-visible');

			// 14. Select 'testrepo' from the suggestions by clicking on it
			await browser.executeObsidian(() => {
				// Find the suggestion element in the popover and click it
				const suggestionElements = Array.from(document.querySelectorAll('.suggestion-item'));
				const testrepoSuggestion = suggestionElements.find(el =>
					el.textContent?.includes('testrepo')
				) as HTMLElement;

				if (!testrepoSuggestion) {
					throw new Error('testrepo suggestion not found in popover');
				}

				// Click the suggestion to select it
				testrepoSuggestion.click();
			});

			await browser.pause(500); // Wait for any UI updates

			// Verify the input was populated with 'testrepo' (use DOM property like owner field)
			const repoProperty = await browser.executeObsidian(() => {
				// Find the repo input by its setting label
				const settingItems = Array.from(document.querySelectorAll('.setting-item'));
				const repoSetting = settingItems.find(item =>
					item.querySelector('.setting-item-name')?.textContent === 'Repository name'
				);
				const input = repoSetting?.querySelector('input') as HTMLInputElement;
				return input?.value || null;
			});
			console.log('Repo value (via DOM property):', repoProperty);
			expect(repoProperty).toBe('testrepo');

			// Take screenshot showing the populated input (proof that suggestion selection worked)
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
