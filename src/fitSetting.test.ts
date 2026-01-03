/**
 * FitSettingTab Integration Tests
 *
 * Purpose: Test settings UI interactions and data flow between UI and orchestration classes.
 * Scope: DOM manipulation, API calls triggered by user interactions, state updates.
 * Out of scope: Testing setTimeout mechanics, Obsidian's Setting class internals.
 *
 * Test Strategy:
 * - Use real FitSettingTab instance with faked dependencies
 * - Verify correct API calls and state updates in response to user actions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import FitSettingTab from './fitSetting';
import { FitLogger } from './logger';

// Fake DOM element that tracks CSS classes and content
class FakeDOMElement {
	classes = new Set<string>();
	text = '';
	children: any[] = [];
	disabled = false;
	selectedIndex = -1;
	innerText = '';

	get options() {
		return this.children;
	}

	addClass(cls: string) { this.classes.add(cls); return this; }
	removeClass(cls: string) { this.classes.delete(cls); return this; }
	setText(text: string) { this.text = text; return this; }
	empty() { this.children = []; return this; }
	createEl(_tag: string, opts?: any) {
		const child = { ...opts };
		this.children.push(child);
		return child;
	}
	add(option: any) {
		this.children.push({ attr: { value: option.value }, text: option.text });
		return this;
	}
}

// Helper to set up DOM fakes for settings UI tests
function createDOMFakes() {
	const elements = {
		ownerDatalist: new FakeDOMElement(),
		repoDatalist: new FakeDOMElement(),
		repoDropdown: new FakeDOMElement(),
		branchDropdown: new FakeDOMElement(),
		linkEl: new FakeDOMElement()
	};

	const querySelector = ((selector: string) => {
		if (selector === '#fit-owner-datalist') return elements.ownerDatalist;
		if (selector === '#fit-repo-datalist') return elements.repoDatalist;
		if (selector === '.repo-dropdown') return elements.repoDropdown;
		if (selector === '.branch-dropdown') return elements.branchDropdown;
		if (selector === '.link-desc') return elements.linkEl;
		return null;
	}) as any;

	return { querySelector, elements };
}

describe('FitSettingTab - handleUserFetch', () => {
	let consoleLogSpy: MockInstance<typeof console.log>;
	let consoleErrorSpy: MockInstance<typeof console.error>;
	let mockLogger: FitLogger;

	beforeEach(() => {
		// Create mock logger for tests
		mockLogger = new FitLogger({ adapter: null });

		// Capture console output for debugging failed tests
		const consoleLogCapture: any[] = [];
		const consoleErrorCapture: any[] = [];

		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
			consoleLogCapture.push(['log', args]);
		});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
			consoleErrorCapture.push(['error', args]);
		});

		// Store captures for afterEach to access
		(global as any).__testConsoleCapture = { log: consoleLogCapture, error: consoleErrorCapture };
	});

	afterEach(() => {
		// Check if test failed - if so, replay captured console output
		const testState = (expect as any).getState();
		const testFailed = testState.currentTestName && testState.assertionCalls > testState.numPassingAsserts;

		const captures = (global as any).__testConsoleCapture;
		// Restore console first (otherwise console.log won't work)
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		if (testFailed && captures && (captures.log.length > 0 || captures.error.length > 0)) {
			console.log('\n==================== CAPTURED CONSOLE OUTPUT (TEST FAILED) ====================');

			// Replay all captured logs in order
			for (const [, args] of captures.log) {
				console.log('[LOG]', ...args);
			}
			for (const [, args] of captures.error) {
				console.error('[ERROR]', ...args);
			}

			console.log('================================================================================\n');
		}

		// Clean up global
		delete (global as any).__testConsoleCapture;
	});

	it('should show error when PAT is missing (githubConnection null)', async () => {
		// Setup: Plugin with no PAT configured
		const fakePlugin: any = {
			githubConnection: null,  // No connection = no PAT
			settings: { authUser: '', avatarUrl: '', repoOwner: '', repo: '', branch: '' },
			fit: {
				clearRemoteVault: () => {},
			},
			saveSettings: () => Promise.resolve(),
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);
		const fakeAvatar = new FakeDOMElement();
		const fakeHandle = new FakeDOMElement();
		settingTab.authUserAvatar = fakeAvatar as any;
		settingTab.authUserHandle = fakeHandle as any;

		// Mock refreshFields to avoid DOM access errors
		settingTab.refreshFields = async () => {};

		// When: User tries to authenticate
		await settingTab.handleUserFetch();

		// Then: Should show error state (not crash with TypeError)
		expect(fakeAvatar.classes.has('error')).toBe(true);
		expect(fakeAvatar.classes.has('cat')).toBe(false);  // Not in loading state
		expect(fakeHandle.text).toContain('token');  // Error mentions token (generic error currently)

		// And: Should not be in authenticating state
		expect(settingTab.authenticating).toBe(false);
	});

	it('should fetch branches for owner/repo combination', async () => {
		// Setup: Plugin with valid connection
		const fakeConnection: any = {
			getBranches: async (owner: string, repo: string) => {
				if (owner === 'user1' && repo === 'repo1') {
					return ['main', 'develop', 'feature-branch'];
				}
				return [];
			}
		};
		const fakePlugin: any = {
			githubConnection: fakeConnection,
			settings: { owner: 'user1', repoOwner: 'user1', repo: 'repo1', branch: '' },
			fit: {},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);
		const { querySelector, elements } = createDOMFakes();
		settingTab.containerEl.querySelector = querySelector;

		// When: refreshFields is called with 'branch(1)'
		await settingTab.refreshFields('branch(1)');

		// Then: Should populate branch dropdown with branches
		expect(elements.branchDropdown.children.map(c => c.attr.value)).toEqual(['main', 'develop', 'feature-branch']);
	});
});
