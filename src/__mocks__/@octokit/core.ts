// Registry for test to inject their fake Octokit instance
let mockOctokitInstance: any = null;

export function __setMockOctokitInstance(instance: any) {
	mockOctokitInstance = instance;
}

export class Octokit {
	constructor(_options?: { auth?: string }) {
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
