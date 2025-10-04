export class Octokit {
	constructor(options?: { auth?: string }) {
		// Mock constructor - store auth if needed for testing
	}

	request(): Promise<{ data: Record<string, unknown> }> {
		return Promise.resolve({ data: {} });
	}

	// Mock plugin method for testing retry functionality
	static plugin(plugin: (octokit: typeof Octokit) => typeof Octokit) {
		return plugin(Octokit);
	}
}
