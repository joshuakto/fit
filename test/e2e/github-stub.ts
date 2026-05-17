/**
 * FIT Plugin GitHub API Stubbing System
 *
 * Stubs GitHub API requests in the browser for E2E testing.
 * Uses structured fixtures (github-fixtures.ts) with plain objects
 * to avoid serialization issues when injecting into browser context.
 *
 * Architecture:
 * 1. Test data lives in github-fixtures.ts (plain objects, easy to maintain)
 * 2. setupGitHubStub() injects config + fetch stub into browser
 * 3. Fetch stub intercepts api.github.com calls and returns fixture data
 * 4. cleanupGitHubStub() restores original fetch
 *
 * Benefits:
 * - Structured test data (easy cause-effect visibility)
 * - No real GitHub API calls (faster, no rate limits)
 * - Works offline
 * - Easy to add new test scenarios
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { browser } from '@wdio/globals';
import { PAT_CONFIGS, type PATConfigId } from './github-fixtures';

/**
 * Setup GitHub API stubbing for a specific PAT configuration
 *
 * @param patId - Key from PAT_CONFIGS (e.g., 'ghp_test')
 *
 * Example:
 *   await setupGitHubStub('ghp_test');
 *   // Now any GitHub API calls will return 'testowner' user data
 */
export async function setupGitHubStub(patId: PATConfigId): Promise<void> {
	const config = PAT_CONFIGS[patId];

	if (!config) {
		throw new Error(`Unknown PAT config: ${patId}`);
	}

	// Inject config and fetch stub into browser context
	// CRITICAL: Pass plain object (cfg) - browser.execute serializes it via JSON
	await browser.execute((cfg) => {
		// Save config and original fetch
		(window as any).__stubConfig = cfg;
		(window as any).__originalFetch = window.fetch;

		// Stub fetch to intercept GitHub API calls
		(window as any).fetch = function(input: any, init?: any): Promise<Response> {
			const url = typeof input === 'string' ? input : input.url;
			const cfg = (window as any).__stubConfig;

			// Helper to create JSON responses
			const jsonResponse = (data: any, status = 200) => {
				return Promise.resolve(new Response(JSON.stringify(data), {
					status,
					headers: { 'content-type': 'application/json' }
				}));
			};

			// Extract path from URL (simple string parsing, no URL constructor)
			// Format: https://api.github.com/path?query
			const apiMatch = url.match(/^https?:\/\/api\.github\.com(\/[^?]*)/);
			if (!apiMatch) {
				// Not a GitHub API call, pass through
				return (window as any).__originalFetch.call(this, input, init);
			}

			const path = apiMatch[1];
			console.log('🔧 Stubbed GitHub API call:', path);

			// Extract auth header (handle both plain object and Headers instance)
			let authHeader;
			if (init?.headers) {
				if (typeof init.headers.get === 'function') {
					// Headers instance
					authHeader = init.headers.get('authorization') || init.headers.get('Authorization');
				} else {
					// Plain object
					authHeader = init.headers.Authorization || init.headers.authorization;
				}
			}

			// GET /user (authenticate user)
			if (path === '/user') {
				if (authHeader === `token ${cfg.pat}`) {
					console.log('✅ /user auth successful');
					return jsonResponse(cfg.user);
				}
				// Auth failed - log diagnostic info (helps debug header parsing issues)
				const headerType = init?.headers ? (typeof init.headers.get === 'function' ? 'Headers instance' : 'plain object') : 'missing';
				console.error(`❌ /user auth failed: no matching PAT (authHeader=${authHeader}, headerType=${headerType})`);
				return jsonResponse({ message: 'Bad credentials' }, 401);
			}

			// GET /user/orgs (get accessible organizations)
			if (path === '/user/orgs') {
				return jsonResponse(cfg.orgs || []);
			}

			// GET /user/repos (authenticated user's repos)
			if (path === '/user/repos') {
				return jsonResponse(cfg.repos[cfg.user.login] || []);
			}

			// GET /users/{user}/repos (specific user's repos)
			const userReposMatch = path.match(/^\/users\/([^/]+)\/repos$/);
			if (userReposMatch) {
				const owner = userReposMatch[1];
				return jsonResponse(cfg.repos[owner] || []);
			}

			// GET /orgs/{org}/repos (organization's repos)
			const orgReposMatch = path.match(/^\/orgs\/([^/]+)\/repos$/);
			if (orgReposMatch) {
				const owner = orgReposMatch[1];
				return jsonResponse(cfg.repos[owner] || []);
			}

			// GET /repos/{owner}/{repo}/git/refs/heads (get branches)
			const branchesMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads$/);
			if (branchesMatch) {
				const owner = branchesMatch[1];
				const repo = branchesMatch[2];
				const repoKey = `${owner}/${repo}`;
				const branches = cfg.branches[repoKey] || [];
				// Convert branches to ref format
				const branchRefs = branches.map((branch: any) => ({
					ref: `refs/heads/${branch.name}`,
					object: { sha: branch.commit.sha }
				}));
				return jsonResponse(branchRefs);
			}

			// Default: Return 404 for unhandled endpoints
			// This makes missing stubs explicit rather than silently passing through to real GitHub
			console.error('❌ Unhandled GitHub API call:', path);
			return jsonResponse({ message: 'Not Found (stub not implemented)' }, 404);
		};
	}, config); // Pass plain object - JSON serialization works!

	console.log(`✅ GitHub API stubbing configured for PAT: ${patId}`);
}

/**
 * Clean up GitHub API stubbing
 *
 * Restores original fetch and removes stub config from browser.
 * Call in afterEach() to ensure clean state between tests.
 */
export async function cleanupGitHubStub(): Promise<void> {
	await browser.execute(() => {
		if ((window as any).__originalFetch) {
			window.fetch = (window as any).__originalFetch;
			delete (window as any).__originalFetch;
		}
		delete (window as any).__stubConfig;
	});

	console.log('🧹 GitHub API stubbing cleaned up');
}
