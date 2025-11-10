import { vi } from 'vitest';

// Mock retry function that returns an enhanced Octokit class
export const retry = vi.fn(() => {
	return class MockOctokitWithRetry {
		retry = {
			retryRequest: vi.fn()
		};
		request = vi.fn();
	};
});
