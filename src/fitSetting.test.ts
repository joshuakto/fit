/**
 * FitSettingTab Integration Tests
 *
 * Purpose: Test settings UI interactions and data flow between UI and orchestration classes.
 * Scope: DOM manipulation, API calls triggered by user interactions, state updates.
 *
 * Test Strategy:
 * - Use real FitSettingTab instance with faked dependencies (GitHubConnection, plugin)
 * - Build actual DOM using githubUserInfoBlock() and repoInfoBlock()
 * - Verify behavior by interacting with real DOM elements and checking results
 * - Focus on user-observable behavior, not internal implementation details
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import FitSettingTab from './fitSetting';
import { FitLogger } from './logger';

const EMPTY_SETTINGS = { pat: '', avatarUrl: '', owner: '', repo: '', branch: '' };

// Helper functions to find elements by their user-visible labels
function findInputByLabel(container: HTMLElement, labelText: string): HTMLInputElement | null {
	const settings = Array.from(container.querySelectorAll('.setting-item'));
	for (const setting of settings) {
		const nameEl = setting.querySelector('.setting-item-name');
		if (nameEl?.textContent === labelText) {
			const input = setting.querySelector('input[type="text"]') as HTMLInputElement;
			return input || null;
		}
	}
	return null;
}

function findButtonByText(container: HTMLElement, buttonText: string): HTMLButtonElement | null {
	const buttons = Array.from(container.querySelectorAll('button'));
	return buttons.find(btn => btn.textContent === buttonText) as HTMLButtonElement || null;
}

describe('FitSettingTab - GitHub settings', () => {
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

		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.resetAllMocks();

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

	it('should have Authenticate button disabled when PAT is missing', async () => {
		const fakePlugin: any = {
			githubConnection: null,
			settings: { ...EMPTY_SETTINGS, pat: '' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// Verify: Authenticate button is disabled when no PAT
		const authenticateButton = findButtonByText(settingTab.containerEl, 'Authenticate user')!;
		expect(authenticateButton.disabled).toBe(true);

		// When: click attempted on disabled button
		authenticateButton.click();

		// Then: Should not enter authenticating state
		expect(settingTab.authenticating).toBe(false);
	});

	it('should authenticate and populate all suggestion lists', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: 'http://example.com/avatar.png' }),
			getAccessibleOwners: async () => ['alice', 'bob'],
			getReposForOwner: async () => ['repo1', 'repo2']
		};

		const fakePlugin: any = {
			githubConnection: null,
			lastGithubConnectionPat: null,
			settings: { ...EMPTY_SETTINGS, pat: '' },
			saveSettings: async () => {
				// Simulate main.ts saveSettings creating GitHubConnection
				if (fakePlugin.settings.pat && fakePlugin.settings.pat !== fakePlugin.lastGithubConnectionPat) {
					fakePlugin.githubConnection = fakeConnection;
					fakePlugin.lastGithubConnectionPat = fakePlugin.settings.pat;
				}
			},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// Get inputs by their labels (user-visible text)
		const patInput = findInputByLabel(settingTab.containerEl, 'Github personal access token')!;
		const ownerInput = findInputByLabel(settingTab.containerEl, 'Repository owner')!;
		const repoInput = findInputByLabel(settingTab.containerEl, 'Repository name')!;

		// Verify: Start in unauthenticated state
		expect(ownerInput.placeholder).toBe('Authenticate above to auto-fill');
		expect(repoInput.placeholder).toBe('Authenticate above for suggestions');

		// When: User enters PAT
		patInput.value = 'ghp_test';
		patInput.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: GitHubConnection created, placeholders updated
		expect(fakePlugin.githubConnection).not.toBeNull();
		expect(ownerInput.placeholder).toBe('owner-username');
		expect(repoInput.placeholder).toBe('repo-name');

		// When: User clicks authenticate button
		const authenticateButton = findButtonByText(settingTab.containerEl, 'Authenticate user')!;
		expect(authenticateButton.disabled).toBe(false);  // Should be enabled now
		authenticateButton.click();
		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Owner pre-filled with authenticated user
		expect(ownerInput.value).toBe('alice');
		expect(fakePlugin.settings.owner).toBe('alice');

		// And: Owner/repo suggestions populated (via AbstractInputSuggest)
		const ownerSuggest = (settingTab as any).ownerSuggest;
		expect(ownerSuggest).toBeDefined();
		expect(ownerSuggest.getSuggestions('')).toEqual(['alice', 'bob']);

		const repoSuggest = (settingTab as any).repoSuggest;
		expect(repoSuggest).toBeDefined();
		expect(repoSuggest.getSuggestions('')).toEqual(['repo1', 'repo2']);
	});

	it('should refresh suggestions for different owners', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
			getAccessibleOwners: async () => ['alice', 'bob'],
			getReposForOwner: async (owner: string) => {
				if (owner === 'alice') return ['repo1', 'repo2', 'repo3'];
				if (owner === 'bob') return ['bob-repo1', 'bob-repo2'];
				return [];
			}
		};
		const fakePlugin: any = {
			githubConnection: fakeConnection,
			settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: 'alice' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// When: User clicks refresh
		const refreshButton = (settingTab as any).refreshButton.querySelector('button') as HTMLButtonElement;
		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Repo suggestions show alice's repos (via AbstractInputSuggest)
		const repoSuggest = (settingTab as any).repoSuggest;
		expect(repoSuggest).toBeDefined();
		let suggestions = repoSuggest.getSuggestions('');
		expect(suggestions).toEqual(['repo1', 'repo2', 'repo3']);

		// When: User changes owner to bob via UI input and refreshes
		const ownerInput = findInputByLabel(settingTab.containerEl, 'Repository owner')!;
		ownerInput.value = 'bob';
		ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);  // Wait for debounced repo fetching

		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Repo suggestions update to show bob's repos
		suggestions = repoSuggest.getSuggestions('');
		expect(suggestions).toEqual(['bob-repo1', 'bob-repo2']);
	});

	it('should populate branch dropdown when owner and repo are set', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
			getAccessibleOwners: async () => ['alice'],
			getReposForOwner: async () => ['vault-repo'],
			getBranches: async (owner: string, repo: string) => {
				if (owner === 'alice' && repo === 'vault-repo') {
					return ['main', 'develop', 'feature-x'];
				}
				return [];
			}
		};
		const fakePlugin: any = {
			githubConnection: fakeConnection,
			settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: 'alice', repo: 'vault-repo' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// When: User clicks refresh
		const refreshButton = (settingTab as any).refreshButton.querySelector('button') as HTMLButtonElement;
		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Branch dropdown is populated
		const branchDropdown = settingTab.containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		const branches = Array.from(branchDropdown.options).map(opt => opt.value);
		expect(branches).toEqual(['main', 'develop', 'feature-x']);
	});

	it('should generate correct GitHub link for owner/repo/branch', async () => {
		const fakePlugin: any = {
			githubConnection: null,
			settings: { owner: 'bob', repo: 'project-x', branch: 'feature-123' },
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Verify: Link uses settings values
		expect(settingTab.getLatestLink()).toBe('https://github.com/bob/project-x/tree/feature-123');
	});

	it('should clear branches when fetching fails (repo not found)', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
			getAccessibleOwners: async () => ['alice'],
			getReposForOwner: async () => ['vault-repo'],
			getBranches: async (_owner: string, repo: string) => {
				if (repo === 'nonexistent') {
					throw new Error("Repository not found");
				}
				return ['main'];
			}
		};
		const fakePlugin: any = {
			githubConnection: fakeConnection,
			settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: 'alice', repo: 'nonexistent' },
			saveSettings: async () => {},
			fit: {
				clearRemoteVault: () => {},
			},
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		// When: User clicks refresh for nonexistent repo
		const refreshButton = (settingTab as any).refreshButton.querySelector('button') as HTMLButtonElement;
		refreshButton.click();

		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		// Then: Branch dropdown is cleared (graceful degradation)
		const branchDropdown = settingTab.containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		expect(branchDropdown.options.length).toBe(0);
		expect(settingTab.existingBranches).toEqual([]);
	});

	it('should enable authenticate button when githubConnection becomes available', async () => {
		const fakeConnection: any = {
			getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: 'http://example.com/avatar.png' }),
			getAccessibleOwners: async () => ['alice'],
			getReposForOwner: async () => []
		};
		const fakePlugin: any = {
			githubConnection: null, // Starts with no connection
			settings: { ...EMPTY_SETTINGS },
			saveSettings: async () => {},
			fit: { clearRemoteVault: () => {} },
			logger: mockLogger
		};

		const settingTab = new FitSettingTab({} as any, fakePlugin);

		// Build UI
		settingTab.githubUserInfoBlock();
		await settingTab.repoInfoBlock();

		const authenticateButton = findButtonByText(settingTab.containerEl, 'Authenticate user')!;

		// Verify: Button starts disabled (no connection)
		expect(authenticateButton.disabled).toBe(true);

		// When: githubConnection becomes available
		fakePlugin.githubConnection = fakeConnection;
		(settingTab as any).updateButtonStates();

		// Then: Button is enabled
		expect(authenticateButton.disabled).toBe(false);

		// And: Clicking works
		authenticateButton.click();
		await vi.advanceTimersByTimeAsync(0);  // Wait for async saveSettings

		expect(settingTab.containerEl.querySelector('.fit-github-handle')?.textContent).toBe('alice');
	});

	describe('Debouncing and performance fixes', () => {
		it('should debounce repo fetching to prevent UI grinding', async () => {
			let fetchCount = 0;
			const fakeConnection: any = {
				getAuthenticatedUser: async () => ({ owner: 'alice', avatarUrl: '' }),
				getAccessibleOwners: async () => ['alice'],
				getReposForOwner: async (owner: string) => {
					fetchCount++;
					return owner === 'the' ? Array(100).fill(null).map((_, i) => `repo-${i}`) : [];
				}
			};
			const fakePlugin: any = {
				githubConnection: fakeConnection,
				settings: { ...EMPTY_SETTINGS, pat: 'ghp_test', owner: '' },
				saveSettings: async () => {},
				fit: { clearRemoteVault: () => {} },
				logger: mockLogger
			};

			const settingTab = new FitSettingTab({} as any, fakePlugin);
			settingTab.githubUserInfoBlock();
			await settingTab.repoInfoBlock();

			const ownerInput = findInputByLabel(settingTab.containerEl, 'Repository owner')!;

			// When: User types "the" character by character
			ownerInput.value = 't';
			ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
			ownerInput.value = 'th';
			ownerInput.dispatchEvent(new Event('input', { bubbles: true }));
			ownerInput.value = 'the';
			ownerInput.dispatchEvent(new Event('input', { bubbles: true }));

			// Then: Should not fetch immediately (debounced)
			expect(fetchCount).toBe(0);

			// When: Advance time by debounce timeout
			vi.advanceTimersByTime(800);

			// Then: Should fetch only once for "the"
			expect(fetchCount).toBe(1);
		});
	});
});
