import { describe, it, expect, vi, type Mock } from 'vitest';
import FitPlugin from '@/fitPlugin';
import type { LocalStores } from '@/localStores';
import type { BlobSha } from '@/util/hashing';

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

		it('merges partial update with existing persisted data', async () => {
			const plugin = makePlugin();
			mockLoad(plugin, { localShas: { 'existing.md': sha('old') }, pendingClashes: [] });

			await (plugin.fitSync as unknown as StubFitSync).simulateSyncSave({ pendingClashes: ['z.md'] });

			expect(plugin.saveData).toHaveBeenCalledWith(
				expect.objectContaining({
					pendingClashes: ['z.md'],
				})
			);
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
