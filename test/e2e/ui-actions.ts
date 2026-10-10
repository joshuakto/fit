/**
 * Actions on and waits for Obsidian's UI, shared by the E2E specs (desktop and Android run the
 * same specs): recording notices, opening FIT's settings, and settings inputs.
 *
 * Every wait is on a condition, never a fixed pause: its timeout only bounds a failure, so it is
 * generous, and a timed-out wait throws an error saying what it saw and attaches a failure
 * snapshot (see diagnostics.ts).
 *
 * Why notices are recorded in the page instead of polled: Obsidian notices are short-lived
 * (the config notice hides ~5s after it appears) and a driver call can take several seconds on a
 * slow emulator, so a poll can miss a notice entirely. Recording inside the page keeps every
 * notice for later reads, whatever the driver does in the meantime.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { browser } from '@wdio/globals';
import { attachFailureSnapshot } from './diagnostics';

const PAT_SETTING = 'Github personal access token';

export interface RecordedNotice {
	text: string;
	/** The notice element's class list, e.g. "notice fit-notice error". */
	classes: string;
	/** performance.now() in the page when the notice was added. */
	addedAtMs: number;
	/** performance.now() in the page when it was removed; undefined while still shown. */
	removedAtMs?: number;
}

export interface NoticeRecorder {
	/** Every notice added since recording started, including ones already gone. */
	read(): Promise<RecordedNotice[]>;
	/**
	 * Resolves with all notices once one containing `text` has been added. On timeout the error
	 * lists what was seen and a failure snapshot is attached to the Allure report.
	 */
	waitFor(text: string, timeoutMs?: number): Promise<RecordedNotice[]>;
}

/**
 * Start recording notices in the page. Call before the action that should produce them.
 * Notices already on screen when this runs are recorded too.
 */
export async function startNoticeRecorder(): Promise<NoticeRecorder> {
	await browser.executeObsidian(() => {
		const w = window as any;
		const entries: RecordedNotice[] = [];
		const byElement = new Map<Element, RecordedNotice>();
		const noticesIn = (node: Node): Element[] => {
			if (!(node instanceof Element)) return [];
			return node.matches('.notice') ? [node] : Array.from(node.querySelectorAll('.notice'));
		};
		const recordAdded = (el: Element) => {
			// Obsidian can re-attach a node; one element is one notice
			if (byElement.has(el)) return;
			const entry: RecordedNotice = {
				text: el.textContent?.trim() || '',
				classes: el.className,
				addedAtMs: Math.round(performance.now()),
			};
			byElement.set(el, entry);
			entries.push(entry);
		};

		w.__fitNotices?.observer.disconnect();
		document.querySelectorAll('.notice').forEach(recordAdded);
		const observer = new MutationObserver(mutations => {
			for (const m of mutations) {
				m.addedNodes.forEach(node => noticesIn(node).forEach(recordAdded));
				m.removedNodes.forEach(node => noticesIn(node).forEach(el => {
					const entry = byElement.get(el);
					if (entry && entry.removedAtMs === undefined && !el.isConnected) {
						entry.removedAtMs = Math.round(performance.now());
					}
				}));
				// Text and classes change after creation (e.g. a notice gets an error class)
				const target = m.target instanceof Element ? m.target : m.target.parentElement;
				const el = target?.closest('.notice');
				const entry = el && byElement.get(el);
				if (el && entry) {
					entry.text = el.textContent?.trim() || entry.text;
					entry.classes = el.className;
				}
			}
		});
		observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
		w.__fitNotices = { entries, observer };

		// A gap in this heartbeat means the page itself froze, as opposed to a slow driver call
		w.__fitHeartbeatGaps = [];
		let last = performance.now();
		clearInterval(w.__fitHeartbeat);
		w.__fitHeartbeat = setInterval(() => {
			const now = performance.now();
			if (now - last > 500) w.__fitHeartbeatGaps.push({ atMs: Math.round(now), gapMs: Math.round(now - last) });
			last = now;
		}, 100);
	});

	const read = () => browser.executeObsidian(() => (window as any).__fitNotices.entries as RecordedNotice[]);

	return {
		read,
		async waitFor(text, timeoutMs = 30000) {
			let seen: RecordedNotice[] = [];
			try {
				await browser.waitUntil(
					async () => {
						seen = await read();
						return seen.some(n => n.text.includes(text));
					},
					{ timeout: timeoutMs, interval: 250 }
				);
			} catch {
				seen = await read();
				await attachFailureSnapshot({ recordedNotices: seen });
				const shown = seen.map(n => JSON.stringify(n.text)).join(', ') || 'none';
				throw new Error(`Notice containing ${JSON.stringify(text)} did not appear within ${timeoutMs}ms. Notices seen: ${shown}`);
			}
			return seen;
		},
	};
}

/**
 * Open Obsidian's settings on FIT's tab, in the current window.
 *
 * Obsidian 1.13+ defaults to opening Settings in a separate OS window on desktop
 * (app.vault.getConfig('settingsPopoutWindow')), and on Android too: both stopped rendering
 * settings in this test's same-window DOM. Force it off so Settings renders in-page, matching
 * pre-1.13 behavior. Neither this config key nor app.setting.close() can be assumed to exist or
 * behave safely on every platform, so the workaround must not throw and block the open below.
 */
export async function openFitSettings() {
	try {
		await browser.executeObsidian(({ app }) => {
			try {
				(app.vault as any).setConfig?.('settingsPopoutWindow', false);
				if ((app as any).setting?.popout) {
					(app as any).setting.close();
				}
			} catch (e) {
				console.warn('settingsPopoutWindow workaround failed in-page:', String(e));
			}
		});
	} catch (e) {
		console.warn('settingsPopoutWindow workaround call itself failed:', String(e));
	}

	// A modal left open by an earlier test would keep a pane rendered before the seed
	// (no token, Authenticate disabled), so close it first.
	await browser.executeObsidian(({ app }) => (app as any).setting?.close?.());
	await browser.waitUntil(
		() => browser.executeObsidian(() => !document.querySelector('.modal-container')),
		{ timeout: 10000, timeoutMsg: 'Settings modal did not close' }
	);
	await browser.executeObsidianCommand('app:open-settings');

	// Navigate to FIT's pane. On Android, Settings can open directly onto the last-active tab's
	// content (no .vertical-tab-nav-item list at all), so only click a tab if FIT's pane isn't
	// showing yet. The click is repeated until the pane renders, which makes this order-independent.
	try {
		await browser.waitUntil(
			() => browser.executeObsidian((_ctx, patSetting) => {
				if (Array.from(document.querySelectorAll('.setting-item-name')).some(el => el.textContent === patSetting)) {
					return true;
				}
				const fitTab = Array.from(document.querySelectorAll('.vertical-tab-nav-item'))
					.find(el => el.textContent?.toLowerCase().includes('fit'));
				(fitTab as HTMLElement | undefined)?.click();
				return false;
			}, PAT_SETTING),
			{ timeout: 20000, interval: 250 }
		);
	} catch {
		await attachFailureSnapshot();
		throw new Error('FIT settings pane did not render: tab not found, or the plugin did not load');
	}
}

/** Current value of the text input of the settings row named `label`, or null if there is none. */
export function readSettingInput(label: string): Promise<string | null> {
	return browser.executeObsidian((_ctx, label) => {
		const row = Array.from(document.querySelectorAll('.setting-item'))
			.find(item => item.querySelector('.setting-item-name')?.textContent === label);
		return row?.querySelector('input')?.value ?? null;
	}, label);
}

/**
 * Wait until the settings input named `label` holds `expected`. On timeout the error says what it
 * held instead and a failure snapshot is attached.
 */
export async function waitForSettingInput(label: string, expected: string, timeoutMs = 15000) {
	let actual: string | null = null;
	try {
		await browser.waitUntil(async () => (actual = await readSettingInput(label)) === expected, { timeout: timeoutMs, interval: 250 });
	} catch {
		await attachFailureSnapshot();
		throw new Error(`Setting "${label}" should be ${JSON.stringify(expected)} within ${timeoutMs}ms but is ${JSON.stringify(actual)}`);
	}
}
