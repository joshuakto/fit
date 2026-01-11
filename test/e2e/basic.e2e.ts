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

			// 2. Navigate to FIT plugin settings
			await browser.executeObsidian(() => {
				// Find FIT tab in settings sidebar
				const fitTab = Array.from(document.querySelectorAll('.vertical-tab-nav-item'))
					.find(el => el.textContent?.includes('FIT'));
				if (fitTab) {
					(fitTab as HTMLElement).click();
				}
			});
			await browser.pause(500);

			// 3. Enter test PAT
			const patInput = await browser.$('input[placeholder*="personal access token"]');
			await patInput.setValue('ghp_test');
			await browser.pause(200); // Allow settings to update

			// 4. Click Authenticate button
			const authButton = await browser.$('button*=Authenticate user');
			await authButton.click();

			// 5. Wait for authentication to complete
			// GitHub API stub will return 'testowner' user
			await browser.pause(500);

			// 6. Verify owner field populated with stubbed user
			const ownerInput = await browser.$('input[list="fit-owner-datalist"]');
			const ownerValue = await ownerInput.getValue();

			expect(ownerValue).toBe('testowner');

			// 7. Take screenshot of authenticated state
			await takeScreenshot('settings-auth-success');

			// 8. Wait for repo dropdown to populate (debounced fetch)
			await browser.pause(800);

			// 9. Focus and expand repo dropdown to show all suggestions
			const repoInput = await browser.$('input[list="fit-repo-datalist"]');

			// 10. Click to focus, then trigger dropdown
			await repoInput.click();
			await browser.pause(200);

			await browser.keys('ArrowDown');
			await browser.pause(200);

			// 11. Verify repo datalist options are populated
			const repoOptions = await browser.executeObsidian(() => {
				const datalist = document.querySelector('#fit-repo-datalist');
				if (!datalist) return [];
				return Array.from(datalist.querySelectorAll('option')).map(opt => opt.value);
			});

			// Should have 2 repos for 'testowner' (from fixtures: testrepo, private-repo)
			expect(repoOptions.sort()).toEqual(['private-repo', 'testrepo']);

			// 12. Select an item from the datalist (simulating user tap/click on mobile)
			// Note: Native datalist dropdowns can't be screenshotted, but we can verify
			// the selection works by programmatically selecting an option and capturing the result

			// Select 'testrepo' option from datalist (simulates user selection)
			await browser.executeObsidian(() => {
				const datalist = document.querySelector('#fit-repo-datalist');
				// Find the 'testrepo' option specifically
				const testrepoOption = Array.from(datalist?.querySelectorAll('option') || [])
					.find(opt => opt.value === 'testrepo');

				if (!testrepoOption) {
					throw new Error('testrepo option not found in datalist');
				}

				// Simulate user selecting 'testrepo' from datalist
				const input = document.querySelector('input[list="fit-repo-datalist"]') as HTMLInputElement;
				if (input) {
					input.value = 'testrepo';
					input.dispatchEvent(new Event('input', { bubbles: true }));
					input.dispatchEvent(new Event('change', { bubbles: true }));
				}
			});

			await browser.pause(500); // Wait for any UI updates

			// Verify the input was populated with 'testrepo'
			const repoValue = await repoInput.getValue();
			console.log(`Selected repo value: ${repoValue}`);
			expect(repoValue).toBe('testrepo');

			// Take screenshot showing the populated input (proof that datalist selection worked)
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
