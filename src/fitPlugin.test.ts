import { describe, it, expect, vi, type Mock, beforeEach } from 'vitest';
import FitPlugin from '@/fitPlugin';
import { FitStatusModal } from '@/fitStatusModal';
import type { LocalStores } from '@/localStores';
import type { BlobSha } from '@/util/hashing';

vi.mock('@/fitStatusModal', () => ({
	// Must use a regular function (not arrow) so it can be used as a constructor with `new`.
	FitStatusModal: vi.fn().mockImplementation(function(
		this: { open: ReturnType<typeof vi.fn>; renderable: unknown },
		_app: unknown, renderable: unknown
	) {
		this.open = vi.fn();
		this.renderable = renderable;
	})
}));

// Minimal stand-in for FitSync: holds the plugin's saveLocalStoreCallback (passed in its
// constructor exactly as real code does) and exposes a helper to simulate a sync save,
// letting tests drive lifecycle operations through the same path as real FitSync calls.
class StubFitSync {
	isActive = false;
	private callback: (store: Partial<LocalStores>) => Promise<void>;

	constructor(callback: (store: Partial<LocalStores>) => Promise<void>) {
		this.callback = callback;
	}

	async simulateSyncSave(data: Partial<LocalStores>) {
		await this.callback(data);
	}

	getSyncErrorMessage = vi.fn().mockReturnValue('error');
	sync = vi.fn();
	explainStatus = vi.fn();
}

function makePlugin() {
	const plugin = new FitPlugin({} as any, {} as any);
	plugin.fit = { loadLocalStore: vi.fn() } as any;
	plugin.fitSync = new StubFitSync(plugin.saveLocalStoreCallback) as any;
	return plugin;
}

function mockLoad(plugin: FitPlugin, data: Record<string, any>) {
	(plugin.loadData as Mock).mockResolvedValue(data);
}

function mockLoadImpl(plugin: FitPlugin, impl: () => Promise<Record<string, any>>) {
	(plugin.loadData as Mock).mockImplementation(impl);
}

function mockSaveImpl(plugin: FitPlugin, impl: (data: any) => Promise<void>) {
	(plugin.saveData as Mock).mockImplementation(impl);
}

const sha = (s: string) => s as BlobSha;

describe('FitPlugin persistence lifecycle', () => {
	describe('after FitSync saves to store', () => {
		it('pendingClashes survive a simulated plugin reload', async () => {
			const plugin = makePlugin();
			let persisted: Record<string, any> = {};
			mockLoadImpl(plugin, () => Promise.resolve({ ...persisted }));
			mockSaveImpl(plugin, (data) => { persisted = data; return Promise.resolve(); });

			await (plugin.fitSync as unknown as StubFitSync).simulateSyncSave({
				localShas: { 'a.md': sha('sha1') },
				pendingClashes: ['x.md'],
			});

			const reloaded = makePlugin();
			mockLoad(reloaded, { ...persisted });
			await reloaded.loadLocalStore();

			expect(reloaded.localStore).toMatchObject({
				localShas: { 'a.md': 'sha1' },
				pendingClashes: ['x.md'],
			});
		});

		it('notifies Fit of the updated store', async () => {
			const plugin = makePlugin();
			mockLoad(plugin, {});

			await (plugin.fitSync as unknown as StubFitSync).simulateSyncSave({
				localShas: { 'f.md': sha('shaF') },
			});

			expect(plugin.fit.loadLocalStore).toHaveBeenCalledWith(
				expect.objectContaining({ localShas: { 'f.md': 'shaF' } })
			);
		});

		it('merges partial update into existing in-memory store', async () => {
			const plugin = makePlugin();
			plugin.localStore = { localShas: { 'existing.md': sha('old') }, pendingClashes: [], lastFetchedCommitSha: null, lastFetchedRemoteShas: {}, lastFetchedRemoteSha: undefined, unpushedFiles: {} };

			await (plugin.fitSync as unknown as StubFitSync).simulateSyncSave({ pendingClashes: ['z.md'] });

			expect(plugin.saveData).toHaveBeenCalledWith(
				expect.objectContaining({
					localShas: { 'existing.md': 'old' },
					pendingClashes: ['z.md'],
				})
			);
		});
	});

	describe('saveLocalStore / saveSettings write merged in-memory state', () => {
		it('saveLocalStore includes settings fields so concurrent saveSettings cannot lose them', async () => {
			const plugin = makePlugin();
			plugin.settings = { pat: 'token', owner: 'alice', repo: 'r', branch: 'main' } as any;
			plugin.localStore = { localShas: { 'a.md': sha('s1') }, pendingClashes: [], lastFetchedCommitSha: null, lastFetchedRemoteShas: {}, lastFetchedRemoteSha: undefined, unpushedFiles: {} };

			await plugin.saveLocalStore();

			expect(plugin.saveData).toHaveBeenCalledWith(
				expect.objectContaining({ pat: 'token', localShas: { 'a.md': 's1' } })
			);
		});

		it('saveSettings includes localStore fields so concurrent saveLocalStore cannot lose them', async () => {
			const plugin = makePlugin();
			plugin.fit = { loadLocalStore: vi.fn(), loadSettings: vi.fn() } as any;
			plugin.settings = { pat: 'token', owner: 'alice', repo: 'r', branch: 'main', checkEveryXMinutes: 5 } as any;
			plugin.localStore = { localShas: {}, pendingClashes: ['x.md'], lastFetchedCommitSha: null, lastFetchedRemoteShas: {}, lastFetchedRemoteSha: undefined, unpushedFiles: {} };
			plugin.startOrUpdateAutoSyncInterval = vi.fn() as any;

			await plugin.saveSettings();

			expect(plugin.saveData).toHaveBeenCalledWith(
				expect.objectContaining({ pat: 'token', pendingClashes: ['x.md'] })
			);
		});

		it('concurrent saveLocalStore + saveSettings both land in the final persisted state', async () => {
			const plugin = makePlugin();
			plugin.fit = { loadLocalStore: vi.fn(), loadSettings: vi.fn() } as any;
			plugin.settings = { pat: 'token' } as any;
			plugin.localStore = { localShas: {}, pendingClashes: ['x.md'], lastFetchedCommitSha: null, lastFetchedRemoteShas: {}, lastFetchedRemoteSha: undefined, unpushedFiles: {} };
			plugin.startOrUpdateAutoSyncInterval = vi.fn() as any;

			// Fire both without awaiting — simulates concurrent execution
			await Promise.all([plugin.saveLocalStore(), plugin.saveSettings()]);

			// Both calls write full merged state, so both contain both sides
			for (const call of (plugin.saveData as Mock).mock.calls) {
				expect(call[0]).toMatchObject({ pat: 'token', pendingClashes: ['x.md'] });
			}
		});
	});

	describe('loadLocalStore from disk', () => {
		it('defaults all fields when stored data is empty', async () => {
			const plugin = makePlugin();
			mockLoad(plugin, {});
			await plugin.loadLocalStore();
			expect(plugin.localStore).toMatchObject({
				localShas: {},
				lastFetchedRemoteShas: {},
				lastFetchedCommitSha: null,
				unpushedFiles: {},
				pendingClashes: [],
			});
		});

		it('migrates legacy lastFetchedRemoteSha field', async () => {
			const plugin = makePlugin();
			mockLoad(plugin, { lastFetchedRemoteSha: { 'file.md': sha('oldsha') } });
			await plugin.loadLocalStore();
			expect(plugin.localStore.lastFetchedRemoteShas).toEqual({ 'file.md': 'oldsha' });
		});
	});
});

describe('FitPlugin.explainSyncStatus routing', () => {
	function makeConfiguredPlugin() {
		const plugin = makePlugin();
		plugin.settings = { pat: 'token', owner: 'alice', repo: 'notes', branch: 'main', autoSync: 'off', checkEveryXMinutes: 30 } as any;
		plugin.fit = { loadLocalStore: vi.fn(), loadSettings: vi.fn() } as any;
		return plugin;
	}

	function stubExplain(plugin: FitPlugin, result: unknown) {
		(plugin.fitSync as unknown as StubFitSync).explainStatus.mockResolvedValue(result);
	}

	beforeEach(() => {
		vi.mocked(FitStatusModal).mockClear();
	});

	it('always opens FitStatusModal regardless of explanation kind', async () => {
		const plugin = makeConfiguredPlugin();
		for (const explanation of [
			{ kind: 'never-synced' },
			{ kind: 'ok', fileCount: 5, shortSha: 'abc1234' },
			{ kind: 'issues', sections: [{ heading: 'h', description: 'd', items: [{ path: 'x.md', cls: 'file-MODIFIED' }] }], scanNote: null },
		]) {
			vi.mocked(FitStatusModal).mockClear();
			stubExplain(plugin, explanation);
			await (plugin as any).explainSyncStatus();
			expect(FitStatusModal).toHaveBeenCalledOnce();
		}
	});
});
