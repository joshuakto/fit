import { describe, it, expect } from 'vitest';
import { apiBaseUrl, tokenCreationUrl, treeUrl, webBaseUrl } from './githubHost';

describe('githubHost', () => {
	it.each([
		['github.com', 'https://api.github.com', 'https://github.com'],
		['  github.com  ', 'https://api.github.com', 'https://github.com'],
		['GitHub.com', 'https://api.github.com', 'https://github.com'],
		['github.example.com', 'https://github.example.com/api/v3', 'https://github.example.com'],
	])('resolves %j to the right base URLs', (githubHost, expectedApiUrl, expectedWebUrl) => {
		expect(apiBaseUrl(githubHost)).toBe(expectedApiUrl);
		expect(webBaseUrl(githubHost)).toBe(expectedWebUrl);
	});

	it('links the fine-grained token page on every host', () => {
		expect(tokenCreationUrl('github.example.com'))
			.toBe('https://github.example.com/settings/personal-access-tokens/new?name=Obsidian%20FIT&description=Obsidian%20FIT%20plugin&contents=write');
		expect(tokenCreationUrl('github.com'))
			.toBe('https://github.com/settings/personal-access-tokens/new?name=Obsidian%20FIT&description=Obsidian%20FIT%20plugin&contents=write');
	});

	it('builds tree URLs on the configured host', () => {
		expect(treeUrl('github.example.com', 'alice', 'vault', 'main'))
			.toBe('https://github.example.com/alice/vault/tree/main');
	});
});
