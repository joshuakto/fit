/**
 * A push must not build on a remote commit that the sync never read. If another
 * device commits between this sync's first remote read and its push, the push
 * would otherwise adopt that commit as its parent, mark the other device's
 * changes as the new baseline, and never pull them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Vault } from 'obsidian';
import { Fit } from './fit';
import { FitSync } from './fitSync';
import { fitLogger } from './logger';
import { init as initEncryption } from './encryption';
import { DEFAULT_SETTINGS, FitSettings } from '@/fitSettings';
import { LocalStores } from '@/localStores';
import { CommitSha, TreeSha, computeGitBlobSha } from './util/hashing';
import { FakeObsidianVault, FakeOctokit, StubTFile } from './testUtils';
import { __setMockOctokitInstance } from './__mocks__/@octokit/core';
import { RemoteGitHubVault } from './remoteGitHubVault';
import { VaultError } from './vault';
import { FileContent, Content } from './util/contentEncoding';

const settings = {
	...DEFAULT_SETTINGS,
	pat: 'fake-test-token',
	githubHost: 'github.com',
	owner: 'test-owner',
	repo: 'test-repo',
	branch: 'main',
	deviceName: 'test-device'
} as FitSettings;

describe('sync push vs. another device', () => {
	let octokit: FakeOctokit;
	let vault: FakeObsidianVault;
	let localStore: LocalStores;

	beforeEach(() => {
		vi.spyOn(fitLogger, 'log').mockImplementation(() => {});
		initEncryption({ settings: { encryptionPassword: '' } } as any);
		octokit = new FakeOctokit('test-owner', 'test-repo', 'main');
		__setMockOctokitInstance(octokit);
		vault = new FakeObsidianVault().enableAdapterList();
		localStore = { localShas: {}, lastFetchedRemoteShas: {}, lastFetchedCommitSha: null, unpushedFiles: {} };
	});

	afterEach(() => {
		__setMockOctokitInstance(null);
		vi.restoreAllMocks();
	});

	async function seedLocal(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			await vault.create(path, content);
		}
	}

	async function seedRemote(files: Record<string, string>) {
		const tree = [];
		for (const [path, content] of Object.entries(files)) {
			const bytes = new TextEncoder().encode(content);
			const sha = await computeGitBlobSha(bytes);
			octokit.addBlob(sha, Buffer.from(bytes).toString('base64'));
			tree.push({ path, mode: '100644' as const, type: 'blob' as const, sha });
		}
		octokit.setupInitialState('commit-0' as CommitSha, 'tree-0' as TreeSha, tree);
	}

	async function sync() {
		const fit = new Fit(settings, localStore, vault as unknown as Vault);
		const fitSync = new FitSync(fit, async (updates: Partial<LocalStores>) => {
			Object.assign(localStore, updates);
			fit.loadLocalStore(localStore);
		});
		return fitSync.sync({ setMessage: vi.fn(), remove: vi.fn() } as any);
	}

	it('pulls the other device changes instead of adopting them as the push baseline', async () => {
		await seedLocal({ 'a.md': 'A0', 'b.md': 'B0' });
		await seedRemote({ 'a.md': 'A0', 'b.md': 'B0' });
		expect(await sync()).toEqual(expect.objectContaining({ success: true }));

		await vault.modify(StubTFile.ofPath('a.md'), 'A-local');

		let moved = false;
		const originalApplyChanges = RemoteGitHubVault.prototype.applyChanges;
		const applySpy = vi.spyOn(RemoteGitHubVault.prototype, 'applyChanges').mockImplementation(
			async function (this: RemoteGitHubVault, filesToWrite, filesToDelete, options) {
				if (!moved) {
					moved = true;
					const otherDevice = new RemoteGitHubVault(
						'other-token', 'test-owner', 'test-repo', 'main', 'other-device', 'github.com');
					await originalApplyChanges.call(otherDevice, [
						{ path: 'b.md', content: FileContent.fromBase64(Content.encodeToBase64('B-other')) },
						{ path: 'other.md', content: FileContent.fromBase64(Content.encodeToBase64('FROM-OTHER-DEVICE')) }
					], []);
				}
				return originalApplyChanges.call(this, filesToWrite, filesToDelete, options);
			});

		const afterRace = await sync();
		applySpy.mockRestore();

		expect(moved).toBe(true);

		expect(await sync()).toEqual(expect.objectContaining({ success: true }));
		expect(vault.getAllFilesAsRaw()).toEqual({
			'a.md': 'A-local',
			'b.md': 'B-other',
			'other.md': 'FROM-OTHER-DEVICE'
		});

		expect(afterRace.success).toBe(false);
		if (afterRace.success) throw new Error('expected the raced sync to fail');
		expect(afterRace.error).toBeInstanceOf(VaultError);
		expect((afterRace.error as VaultError).type).toBe('remote_moved');
	});
});
