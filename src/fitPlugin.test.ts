// Unit tests for FitPlugin: persistence lifecycle, sync-outcome UI coordination, and
// settings-driven notice behavior. Mocks only true external boundaries (Obsidian's
// Notice/Modal/Plugin API via src/__mocks__/obsidian.ts); internal collaborators like
// src/utils.ts's showFileChanges run for real so their own logic stays covered here.
// See src/fitStatusExplainer.test.ts for the status-explanation formatting itself.
import { describe, it, expect, vi, type Mock, beforeEach } from 'vitest';
import FitPlugin from '@/fitPlugin';
import { FitStatusModal } from '@/fitStatusModal';
import { DEFAULT_SETTINGS } from '@/fitSettings';
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

const { NoticeCtor } = vi.hoisted(() => ({ NoticeCtor: vi.fn() }));

// Spy on the real (mocked-Obsidian) Notice constructor rather than mocking showFileChanges
// itself, so showFileChanges's own DOM-building logic stays exercised by these tests.
vi.mock('obsidian', async (importOriginal) => {
	const actual = await importOriginal<typeof import('obsidian')>();
	class SpyNotice extends actual.Notice {
		constructor(message: string, duration?: number) {
			super(message, duration);
			NoticeCtor(message, duration);
		}
	}
	return { ...actual, Notice: SpyNotice };
});

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

describe('FitPlugin sync-success notice duration wiring', () => {
	// fileChangesNoticeDurationSec is stored in seconds (Setting UI is a 0-60s slider);
	// Notice's constructor wants milliseconds. This covers the unit conversion at the
	// showFileChanges call site (src/fitPlugin.ts), not showFileChanges's own pass-through.
	// settingsOverride left {} = no override, so DEFAULT_SETTINGS' own value (0) flows
	// through untouched, same as a real fresh install.
	function makeConfiguredPlugin(settingsOverride: Partial<typeof DEFAULT_SETTINGS> = {}) {
		const plugin = makePlugin();
		plugin.settings = {
			...DEFAULT_SETTINGS,
			pat: 'token', owner: 'alice', repo: 'notes', branch: 'main',
			notifyChanges: true,
			notifyConflicts: false,
			...settingsOverride,
		};
		plugin.fit = { loadLocalStore: vi.fn(), loadSettings: vi.fn() } as any;
		plugin.fitSyncRibbonIconEl = { addClass: vi.fn(), removeClass: vi.fn() } as any;
		return plugin;
	}

	const successOutcome = {
		success: true,
		changeGroups: [{ heading: 'Local file updates:', changes: [{ path: 'notes/a.md', type: 'ADDED' }] }],
		clash: []
	};

	beforeEach(() => {
		NoticeCtor.mockClear();
	});

	// onSyncStart also creates a Notice ("Initiating sync"/"Auto syncing") independent of
	// this setting, so we isolate the file-changes notice by its distinct (empty) message.
	it('converts fileChangesNoticeDurationSec (seconds) to milliseconds for the Notice', async () => {
		const plugin = makeConfiguredPlugin({ fileChangesNoticeDurationSec: 30 });
		(plugin.fitSync as unknown as StubFitSync).sync.mockResolvedValue(successOutcome);

		await (plugin as any).executeSyncWithUICoordination('manual');
		await vi.waitFor(() => expect(NoticeCtor).toHaveBeenCalledWith('', 30000));
	});

	it('creates the notice with duration 0 when no custom duration is configured', async () => {
		const plugin = makeConfiguredPlugin(); // no override - real DEFAULT_SETTINGS value is used
		(plugin.fitSync as unknown as StubFitSync).sync.mockResolvedValue(successOutcome);

		await (plugin as any).executeSyncWithUICoordination('manual');
		await vi.waitFor(() => expect(NoticeCtor).toHaveBeenCalledWith('', 0));
	});

	it('does not create a file-changes notice when notifyChanges is disabled', async () => {
		const plugin = makeConfiguredPlugin({ fileChangesNoticeDurationSec: 30 });
		plugin.settings.notifyChanges = false;
		(plugin.fitSync as unknown as StubFitSync).sync.mockResolvedValue(successOutcome);

		await (plugin as any).executeSyncWithUICoordination('manual');
		// Flush the fire-and-forget async block in executeSyncWithUICoordination
		// so a false positive (call happening after assertion) can't hide here.
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(NoticeCtor).not.toHaveBeenCalledWith('', expect.anything());
	});
});

describe('FitPlugin sync-error notice content (#214)', () => {
	// A plain authentication failure (bad/revoked/expired token — indistinguishable from
	// the response) is the one case worth making actionable: a settings link.
	// rate_limited/sso_required aren't fixed by touching the token, so getSyncErrorMessage's
	// own message text is trusted as-is there — no separate check needed here.
	function makeConfiguredPlugin() {
		const plugin = makePlugin();
		plugin.settings = {
			...DEFAULT_SETTINGS,
			pat: 'token', owner: 'alice', repo: 'notes', branch: 'main',
		};
		plugin.fit = { loadLocalStore: vi.fn(), loadSettings: vi.fn() } as any;
		plugin.fitSyncRibbonIconEl = { addClass: vi.fn(), removeClass: vi.fn() } as any;
		return plugin;
	}

	it('adds a settings link (wired to openPluginSettings) for a plain authentication failure', async () => {
		const plugin = makeConfiguredPlugin();
		const openSettingsSpy = vi.spyOn(plugin, 'openPluginSettings').mockImplementation(() => {});
		const stub = plugin.fitSync as unknown as StubFitSync;
		stub.sync.mockResolvedValue({ success: false, error: { type: 'authentication', details: {} } });
		stub.getSyncErrorMessage.mockReturnValue('Bad credentials. Check your GitHub personal access token.');

		await (plugin as any).executeSyncWithUICoordination('manual');

		const errorNotice = (plugin as any).currentSyncNotice.notice;
		const [message] = errorNotice.setMessage.mock.calls.at(-1);
		const links = Array.from((message as DocumentFragment).querySelectorAll('a'));

		links.find(a => a.textContent === 'Open plugin settings')!.dispatchEvent(new MouseEvent('click'));
		expect(openSettingsSpy).toHaveBeenCalled();
	});
});
