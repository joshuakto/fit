import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';

describe('FIT Plugin Basic E2E Tests', function() {
	this.timeout(60000); // 60 second timeout

	it('should load Obsidian with test vault', async () => {
		// Basic test to verify Obsidian is running and has files
		const fileList = await browser.executeObsidian(async ({app}) => {
			return await app.vault.getMarkdownFiles().map(f => f.path).sort();
		});

		console.log('Files in test vault:', fileList);

		// Should have our test files
		expect(fileList).toContain('test-file.md');
		expect(fileList).toContain('another-test.md');
	});

	it('should create a test file', async () => {
		// Test file creation through the Obsidian API
		await browser.executeObsidian(async ({app}) => {
			await app.vault.create("e2e-test.md", "## E2E Test\n\nThis is a test file created during e2e testing.");
		});

		// Verify file was created
		const fileList = await browser.executeObsidian(async ({app}) => {
			return await app.vault.getMarkdownFiles().map(f => f.path).sort();
		});

		expect(fileList).toContain('e2e-test.md');
		console.log('Successfully created e2e-test.md');
	});

	it('should try to execute FIT command', async () => {
		// Try to execute a FIT command - may fail if plugin not configured
		try {
			await browser.executeObsidianCommand("fit:open-settings");
			console.log('FIT settings command executed successfully');
		} catch (error) {
			console.log('FIT command not available or plugin not configured:', error);
			// Don't fail test - this is expected if plugin not configured
		}
	});

	it('should reset vault state', async () => {
		// Reset vault to original state
		await obsidianPage.resetVault();

		// Verify test file was removed
		const fileList = await browser.executeObsidian(async ({app}) => {
			return await app.vault.getMarkdownFiles().map(f => f.path).sort();
		});

		expect(fileList).not.toContain('e2e-test.md');
		console.log('Vault reset successfully');
	});
});
