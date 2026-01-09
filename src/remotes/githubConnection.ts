/**
 * GitHub Connection Manager
 *
 * Encapsulates GitHub-specific connection logic and authentication.
 * Separates PAT-based operations (authentication, discovery) from
 * repository-specific operations (handled by RemoteGitHubVault).
 *
 * This class solves the chicken-and-egg problem where settings UI needs
 * to authenticate and fetch repos BEFORE having owner/repo/branch configured.
 *
 * TODO: Future - Extract RemoteConnection interface when adding GitLab/Gitea support
 * TODO: Future - Extract IVaultApiClient interface for RemoteVault abstraction
 */

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { VaultError } from "../vault";

/**
 * Authenticated user information from GitHub
 */
export interface AuthenticatedUser {
	owner: string;      // GitHub username/login
	avatarUrl: string;  // Avatar URL
}

/**
 * Configuration errors - thrown when connection is not properly configured
 */
export class ConnectionConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConnectionConfigError';
	}
}

/**
 * GitHub connection manager.
 * Handles authentication, repository discovery, and Octokit instance management.
 *
 * Usage:
 *   const conn = new GitHubConnection(pat);
 *   const user = await conn.getAuthenticatedUser();
 *   const repos = await conn.getReposForOwner(user.owner);
 */
export class GitHubConnection {
	private octokit: Octokit;
	private pat: string;
	private headers: {[k: string]: string};

	// Cached authenticated user info (populated on first getAuthenticatedUser call)
	private cachedAuthUser: AuthenticatedUser | null = null;

	constructor(pat: string) {
		this.pat = pat;
		const OctokitWithRetry = Octokit.plugin(retry);
		this.octokit = new OctokitWithRetry({
			auth: pat,
			request: {
				retries: 3,
				doNotRetry: [400, 401, 403, 404, 422]
			}
		});
		this.headers = {
			'X-GitHub-Api-Version': '2022-11-28',
		};
	}

	/**
	 * Check if connection has a PAT configured
	 */
	get isConfigured(): boolean {
		return !!this.pat;
	}

	/**
	 * Get authenticated user information.
	 * Caches result for subsequent calls.
	 *
	 * @throws VaultError on authentication failure or network error
	 */
	async getAuthenticatedUser(): Promise<AuthenticatedUser> {
		// Return cached value if available
		if (this.cachedAuthUser) {
			return this.cachedAuthUser;
		}

		try {
			const {data: response} = await this.octokit.request(
				`GET /user`, {
					headers: this.headers
				});

			const authUser: AuthenticatedUser = {
				owner: response.login,
				avatarUrl: response.avatar_url
			};

			// Cache for subsequent calls
			this.cachedAuthUser = authUser;
			return authUser;
		} catch (error) {
			return await this.wrapOctokitError(error);
		}
	}

	/**
	 * Get list of unique owners (user + organizations + collaborator repos) accessible to authenticated user.
	 * Returns sorted array of owner names.
	 *
	 * @throws VaultError on authentication failure or network error
	 */
	async getAccessibleOwners(): Promise<string[]> {
		try {
			// Get authenticated user
			const authUser = await this.getAuthenticatedUser();
			const owners = new Set<string>();
			owners.add(authUser.owner);

			// Get organizations with pagination
			// TODO: Also return collaborator owners.
			const perPage = 100;
			let page = 1;
			let hasMoreOrgs = true;

			while (hasMoreOrgs) {
				const {data: orgs} = await this.octokit.request(
					`GET /user/orgs`, {
						headers: this.headers,
						per_page: perPage,
						page: page
					});

				orgs.forEach(org => owners.add(org.login));
				hasMoreOrgs = orgs.length === perPage;
				page++;
			}

			// Get repos where user has collaborator access to find additional owners
			page = 1;
			let hasMoreCollabRepos = true;

			while (hasMoreCollabRepos) {
				const {data: repos} = await this.octokit.request(
					`GET /user/repos`, {
						affiliation: "collaborator",
						headers: this.headers,
						per_page: perPage,
						page: page
					});

				repos.forEach(repo => owners.add(repo.owner.login));
				hasMoreCollabRepos = repos.length === perPage;
				page++;
			}

			return Array.from(owners).sort();
		} catch (error) {
			return await this.wrapOctokitError(error);
		}
	}

	/**
	 * Get list of repositories for a specific owner that authenticated user has access to.
	 *
	 * For the authenticated user: returns repos they own.
	 * For collaborator repos: returns repos where user has explicit granted access.
	 * For organizations: returns all org repos (uses separate API endpoint for efficiency).
	 *
	 * @param owner - The owner (user or organization) to fetch repos for
	 * @throws VaultError on authentication failure or network error
	 */
	async getReposForOwner(owner: string): Promise<string[]> {
		try {
			const authUser = await this.getAuthenticatedUser();
			const allRepos: string[] = [];
			const perPage = 100;
			let page = 1;
			let hasMorePages = true;

			// If owner is the authenticated user, fetch their owned repos
			if (owner === authUser.owner) {
				while (hasMorePages) {
					const {data: response} = await this.octokit.request(
						`GET /user/repos`, {
							affiliation: "owner",
							headers: this.headers,
							per_page: perPage,
							page: page
						});
					allRepos.push(...response.map(r => r.name));
					hasMorePages = response.length === perPage;
					page++;
				}
			} else {
				// For other owners, try org endpoint first (most efficient for orgs with many repos)
				try {
					while (hasMorePages) {
						const {data: response} = await this.octokit.request(
							`GET /orgs/{org}/repos`, {
								org: owner,
								headers: this.headers,
								per_page: perPage,
								page: page
							});
						allRepos.push(...response.map(r => r.name));
						hasMorePages = response.length === perPage;
						page++;
					}
				} catch (orgError: unknown) {
					// If org endpoint fails (owner might be a user, not an org),
					// fall back to collaborator repos (filters to repos with write access)
					const errorObj = orgError as { status?: number };
					if (errorObj.status === 404) {
						// Owner is not an org, fetch collaborator repos and filter by owner
						page = 1;
						hasMorePages = true;
						while (hasMorePages) {
							const {data: response} = await this.octokit.request(
								`GET /user/repos`, {
									affiliation: "collaborator",
									headers: this.headers,
									per_page: perPage,
									page: page
								});
							// Filter to only repos matching the requested owner
							const matchingRepos = response
								.filter(r => r.owner.login === owner)
								.map(r => r.name);
							allRepos.push(...matchingRepos);
							hasMorePages = response.length === perPage;
							page++;
						}
					} else {
						// Other error (auth, network, etc.) - re-throw
						throw orgError;
					}
				}
			}

			return allRepos.sort();
		} catch (error) {
			return await this.wrapOctokitError(error, { owner });
		}
	}

	/**
	 * List branches in a repository.
	 *
	 * @param owner - Repository owner
	 * @param repo - Repository name
	 * @throws VaultError on authentication failure, network error, or repo not found
	 */
	async getBranches(owner: string, repo: string): Promise<string[]> {
		try {
			const allBranches: string[] = [];
			const perPage = 100;
			let page = 1;
			let hasMoreBranches = true;

			while (hasMoreBranches) {
				const {data: response} = await this.octokit.request(
					`GET /repos/{owner}/{repo}/branches`,
					{
						owner: owner,
						repo: repo,
						headers: this.headers,
						per_page: perPage,
						page: page
					});

				allBranches.push(...response.map(r => r.name));
				hasMoreBranches = response.length === perPage;
				page++;
			}

			return allBranches;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, { owner, repo });
		}
	}

	/**
	 * Get configured Octokit instance for use by RemoteGitHubVault.
	 * Provides access to underlying GitHub API client.
	 *
	 * TODO: Future - RemoteGitHubVault should accept Octokit in constructor
	 * instead of creating its own. This method is interim solution.
	 */
	getOctokit(): Octokit {
		return this.octokit;
	}

	/**
	 * Get API headers used for GitHub requests.
	 * Needed by RemoteGitHubVault for consistency.
	 *
	 * TODO: Future - Consolidate header management in GitHubConnection
	 */
	getHeaders(): {[k: string]: string} {
		return this.headers;
	}

	/**
	 * Wrap Octokit errors in VaultError for consistent error handling.
	 *
	 * Note: This is a simplified version compared to RemoteGitHubVault.wrapOctokitError.
	 * We don't distinguish between "repo not found" vs "branch not found" because
	 * getBranches() only takes owner/repo (no branch context). For more detailed
	 * error messages, see RemoteGitHubVault which has notFoundStrategy parameter.
	 *
	 * @param error - The caught error from Octokit
	 * @param context - Optional context for better error messages (owner, repo)
	 */
	private async wrapOctokitError(
		error: unknown,
		context?: { owner?: string; repo?: string }
	): Promise<never> {
		const errorObj = error as { status?: number | null; response?: unknown; message?: string; };

		// No status or no response indicates network/connectivity issue
		if (errorObj.status === null || errorObj.status === undefined || !errorObj.response) {
			throw VaultError.network(
				errorObj.message || "Couldn't reach GitHub API",
				{ originalError: error }
			);
		}

		// 401/403: Authentication/authorization failures
		if (errorObj.status === 401 || errorObj.status === 403) {
			throw VaultError.authentication(
				errorObj.message || 'Authentication failed. Check your PAT token.',
				{ originalError: error }
			);
		}

		// 404: Resource not found - provide context-specific message
		if (errorObj.status === 404) {
			let message = 'GitHub API endpoint not found';
			if (context?.owner && context?.repo) {
				message = `Repository '${context.owner}/${context.repo}' not found or inaccessible`;
			} else if (context?.owner) {
				message = `Owner '${context.owner}' not found or inaccessible`;
			}
			throw VaultError.network(message, { originalError: error });
		}

		// Other errors: re-throw as-is
		throw error;
	}
}
