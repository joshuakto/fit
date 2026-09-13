import { describe, it, expect } from 'vitest';
import { GitHubConnection } from './githubConnection';
import { __getLastOctokitOptions } from '../__mocks__/@octokit/core';

describe('GitHubConnection', () => {
	it('targets api.github.com', () => {
		new GitHubConnection('fake-pat', "github.com");
		expect(__getLastOctokitOptions()?.baseUrl).toBe('https://api.github.com');
	});

	it('targets the instance API when an Enterprise Server host is configured', () => {
		new GitHubConnection('fake-pat', 'github.example.com');
		expect(__getLastOctokitOptions()?.baseUrl).toBe('https://github.example.com/api/v3');
	});
});
