import { vi } from 'vitest';

// Define mocks in outer scope so they're tracked by Vitest's global mock registry
// This ensures vi.clearAllMocks() and vi.resetAllMocks() work correctly
const mockRetryRequest = vi.fn();
const mockRequest = vi.fn();

// Mock retry function that returns an enhanced Octokit class
export const retry = vi.fn(() => {
	return class MockOctokitWithRetry {
		retry = {
			retryRequest: mockRetryRequest
		};
		request = mockRequest;
	};
});
