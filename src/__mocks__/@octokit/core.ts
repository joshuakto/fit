// Registry for test to inject their fake Octokit instance
let mockOctokitInstance: any = null;
let lastConstructorOptions: Record<string, any> | null = null;

export function __setMockOctokitInstance(instance: any) {
	mockOctokitInstance = instance;
}

// Options from the most recent Octokit construction, for asserting client config (baseUrl, auth)
export function __getLastOctokitOptions(): Record<string, any> | null {
	return lastConstructorOptions;
}

export class Octokit {
	constructor(options?: Record<string, any>) {
		lastConstructorOptions = options ?? null;
		// If a mock instance is registered, return it instead
		if (mockOctokitInstance) {
			return mockOctokitInstance;
		}
		// Otherwise this is a basic mock
	}

	request(): Promise<{ data: Record<string, unknown> }> {
		return Promise.resolve({ data: {} });
	}

	// Mock plugin method - returns a constructor that uses the mock instance
	static plugin(_plugin: any) {
		return Octokit;  // Return the same class (which will use mockOctokitInstance)
	}
}
