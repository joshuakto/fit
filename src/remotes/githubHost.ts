/**
 * GitHub Host Resolution
 *
 * Resolves the configured host into the API base URL used by Octokit
 * this handles differentiating github.com and self-hosted github instances - though they use the same api
 */

const DOTCOM_HOST = "github.com";
const DOTCOM_API_URL = "https://api.github.com";

function normalizeHost(githubHost: string): string {
	return githubHost.trim().toLowerCase();
}

/**
 * Origin for user-facing links, e.g. "https://github.example.com".
 *
 * @param githubHost - Bare hostname, e.g. "github.example.com" or "github.com"
 */
export function webBaseUrl(githubHost: string): string {
	return `https://${normalizeHost(githubHost)}`;
}

/** Octokit baseUrl for the configured host. */
export function apiBaseUrl(githubHost: string): string {
	const host = normalizeHost(githubHost);
	// github.com is the only host that serves its API from a separate origin
	return host === DOTCOM_HOST ? DOTCOM_API_URL : `https://${host}/api/v3`;
}

/**
 * URL of the fine-grained token creation page, pre-filled with the access FIT needs.
 * classic tokens also work, but are less desirable from a security perspective
 */
export function tokenCreationUrl(githubHost: string): string {
	return `${webBaseUrl(githubHost)}/settings/personal-access-tokens/new?name=Obsidian%20FIT&description=Obsidian%20FIT%20plugin&contents=write`;
}

/** URL of the web view of a repository at a branch or commit. */
export function treeUrl(githubHost: string, owner: string, repo: string, ref: string): string {
	return `${webBaseUrl(githubHost)}/${owner}/${repo}/tree/${ref}`;
}
