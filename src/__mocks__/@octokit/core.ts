export class Octokit {
	constructor(options?: { auth?: string }) {
		// Mock constructor - store auth if needed for testing
	}

	request(): Promise<{ data: Record<string, unknown> }> {
		return Promise.resolve({ data: {} });
	}
}
