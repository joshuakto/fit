/**
 * GitHub API Test Fixtures
 *
 * Structured test data for stubbing GitHub API responses.
 * Plain objects only (no classes) for clean serialization to browser context.
 *
 * Each PAT configuration represents a complete test scenario with:
 * - User authentication data
 * - Accessible organizations
 * - Repositories by owner
 * - Branches by repo
 *
 * Usage:
 *   setupGitHubStub('ghp_test') → Returns 'testowner' user
 *   setupGitHubStub('ghp_turkish_test') → Returns Turkish character user (future)
 */

export interface GitHubUser {
	login: string;
	avatar_url: string;
}

export interface GitHubOrg {
	login: string;
}

export interface GitHubRepo {
	name: string;
	private?: boolean;
	description?: string;
}

export interface GitHubBranch {
	name: string;
	commit: {
		sha: string;
	};
}

export interface PATConfig {
	pat: string;
	user: GitHubUser;
	orgs: GitHubOrg[];
	repos: Record<string, GitHubRepo[]>; // owner -> repos
	branches: Record<string, GitHubBranch[]>; // "owner/repo" -> branches
}

/**
 * Test PAT configurations
 *
 * Easy to see cause-effect relationship:
 * - Test uses 'ghp_test' → Gets 'testowner' user
 * - Owner dropdown populated from repos.testowner
 * - Branch dropdown populated from branches['testowner/testrepo']
 */
export const PAT_CONFIGS: Record<string, PATConfig> = {
	'ghp_test': {
		pat: 'ghp_test',
		user: {
			login: 'testowner',
			avatar_url: 'https://avatars.githubusercontent.com/u/12345'
		},
		orgs: [
			{ login: 'testorg' }
		],
		repos: {
			'testowner': [
				{ name: 'testrepo', private: false, description: 'Test repository' },
				{ name: 'private-repo', private: true, description: 'Private test repo' }
			],
			'testorg': [
				{ name: 'org-repo', private: false, description: 'Organization repository' }
			]
		},
		branches: {
			'testowner/testrepo': [
				{ name: 'main', commit: { sha: 'abc123def456' } },
				{ name: 'develop', commit: { sha: 'def456abc123' } }
			],
			'testowner/private-repo': [
				{ name: 'main', commit: { sha: '789xyz' } }
			],
			'testorg/org-repo': [
				{ name: 'main', commit: { sha: 'org123' } },
				{ name: 'staging', commit: { sha: 'org456' } }
			]
		}
	}
};

export type PATConfigId = keyof typeof PAT_CONFIGS;
