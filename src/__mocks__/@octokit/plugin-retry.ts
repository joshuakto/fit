// Mock retry function that returns an enhanced Octokit class
export const retry = jest.fn(() => {
	return class MockOctokitWithRetry {
		retry = {
			retryRequest: jest.fn()
		};
		request = jest.fn();
	};
});
