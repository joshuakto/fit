/**
 * Operation counts and sequencing of whole syncs, recorded from the test doubles (GitHub requests
 * and local vault filesystem calls) for fixed vault sizes. The snapshots in __snapshots__/syncOps/
 * back docs/sync-performance-inventory.md: when a change moves a count or lengthens a phase chain,
 * the diff shows it. Regenerate with `npm test -- src/syncOps.test.ts -u` and review the diff.
 *
 * Each scenario also asserts the outcome (what landed where), so a blind `-u` cannot bless a sync
 * that did the wrong thing. Counts are deliberately not asserted: they describe today's cost, and
 * an improvement should only change the snapshot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { Vault } from 'obsidian';
import { Fit } from './fit';
import { FitSync } from './fitSync';
import { fitLogger } from './logger';
import { init as initEncryption } from './encryption';
import { DEFAULT_SETTINGS, FitSettings } from '@/fitSettings';
import { LocalStores } from '@/localStores';
import { CommitSha, computeGitBlobSha, TreeSha } from './util/hashing';
import { FakeObsidianVault, FakeOctokit, OpRecorder, instrumentOps, settleWithVirtualTime } from './testUtils';
import { __setMockOctokitInstance } from './__mocks__/@octokit/core';

const N = 100;

const settings = {
	...DEFAULT_SETTINGS,
	pat: 'fake-test-token',
	githubHost: 'github.com',
	owner: 'test-owner',
	repo: 'test-repo',
	branch: 'main',
	deviceName: 'test-device'
} as FitSettings;

function noteFiles(count: number, content = (i: number) => `note ${i}`): Record<string, string> {
	return Object.fromEntries(
		Array.from({ length: count }, (_, i) => [`notes/note-${String(i).padStart(4, '0')}.md`, content(i)]));
}

describe('sync operation counts', () => {
	let octokit: FakeOctokit;
	let vault: FakeObsidianVault;
	let recorder: OpRecorder;
	let localStore: LocalStores;

	beforeEach(() => {
		// Recorded calls take virtual time. Nothing else may wait on the real event loop, or the
		// virtual clock could move on before it finishes: SubtleCrypto digests run on a real thread,
		// so answer them in a microtask instead.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => {
			const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
			const hash = createHash('sha1').update(bytes).digest();
			return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
		});
		vi.spyOn(fitLogger, 'log').mockImplementation(() => {});
		initEncryption({ settings: { encryptionPassword: '' } } as any);
		octokit = new FakeOctokit('test-owner', 'test-repo', 'main');
		__setMockOctokitInstance(octokit);
		vault = new FakeObsidianVault().enableAdapterList();
		recorder = new OpRecorder();
		instrumentOps(recorder, octokit, vault);
		localStore = { localShas: {}, lastFetchedRemoteShas: {}, lastFetchedCommitSha: null, unpushedFiles: {} };
	});

	afterEach(() => {
		__setMockOctokitInstance(null);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function seedLocal(files: Record<string, string>) {
		await settleWithVirtualTime(Promise.all(Object.entries(files).map(([path, content]) => vault.create(path, content))));
		recorder.reset(); // arranging is not part of the sync
	}

	/** Remote repo whose branch holds `files`, with real git blob SHAs so local hashes match. */
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

	/** Run one sync with a fresh Fit over the shared stores, as the plugin does per sync. */
	async function sync() {
		const fit = new Fit(settings, localStore, vault as unknown as Vault);
		const fitSync = new FitSync(fit, async (updates: Partial<LocalStores>) => {
			Object.assign(localStore, updates);
			fit.loadLocalStore(localStore);
		});
		const notice = { setMessage: vi.fn(), remove: vi.fn() };
		const result = await settleWithVirtualTime(fitSync.sync(notice as any));
		expect(result).toEqual(expect.objectContaining({ success: true }));
	}

	/** Sync once unrecorded to reach a settled state, then record the next sync. */
	async function recordNextSync() {
		await sync();
		recorder.reset();
		await sync();
	}

	describe(`${N} files`, () => {
		it('given 100 local files and an empty remote, should push them as parallel blob creations then one commit', async () => {
			await seedLocal(noteFiles(N));
			await seedRemote({});

			await sync();

			expect(octokit.getCurrentTree()?.map(node => node.path).sort()).toEqual(Object.keys(noteFiles(N)));
			await expect(recorder.report()).toMatchFileSnapshot('__snapshots__/syncOps/first-push.txt');
		});

		it('given 100 remote files and an empty vault, should pull them as parallel blob reads', async () => {
			await seedRemote(noteFiles(N));

			await sync();

			expect(vault.getAllFilesAsRaw()).toEqual(noteFiles(N));
			await expect(recorder.report()).toMatchFileSnapshot('__snapshots__/syncOps/first-pull.txt');
		});

		it('given 100 files unchanged on both sides, should read the local files and make no blob requests', async () => {
			const files = noteFiles(N);
			await seedLocal(files);
			await seedRemote(files);

			await recordNextSync();

			expect(recorder.counts()['GET git/blobs/{file_sha}']).toBeUndefined();
			expect(recorder.counts()['POST git/commits']).toBeUndefined();
			await expect(recorder.report()).toMatchFileSnapshot('__snapshots__/syncOps/steady-state.txt');
		});
	});
});
