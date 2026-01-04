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
			expect(configNotice).toBeDefined();
			expect(configNotice?.text).toContain('Settings not configured');

			// 7. Verification complete - screenshot saved proves functionality works

			console.log('✅ Complete FIT sync test with screenshot verification successful');
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
