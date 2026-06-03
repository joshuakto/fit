import { App, Modal } from 'obsidian';
import type { RenderableExplanation } from '@/fitStatusExplainer';
import { ObsidianSyncRules, findNewFields } from '@/fitSettings';

const FILE_TOOLTIP: Record<string, string> = {
	'file-needs-resolution': 'Conflict — review or delete the _fit/ counterpart, then sync again. Hidden files (starting with .) won\'t appear in Obsidian\'s file explorer; use a desktop file manager.',
	'file-ADDED':            'Added locally — will push on next sync.',
	'file-MODIFIED':         'Modified locally — will push on next sync.',
	'file-REMOVED':          'Deleted locally — will push on next sync.',
	'file-push-skipped':     'Exceeds GitHub file size limit — reduce size or remove to sync.',
};

export class FitStatusModal extends Modal {
	private renderable: RenderableExplanation;
	private obsidianSyncRules: ObsidianSyncRules;

	constructor(app: App, renderable: RenderableExplanation, obsidianSyncRules: ObsidianSyncRules = {}) {
		super(app);
		this.renderable = renderable;
		this.obsidianSyncRules = obsidianSyncRules;
	}

	onOpen() {
		const { contentEl } = this;
		const { title, commitUrl, statusNote, autoSyncNote, sections, scanNote } = this.renderable;

		contentEl.createEl('h2', { text: title });

		if (commitUrl) {
			const p = contentEl.createEl('p');
			p.createSpan({ text: 'Synced to commit ' });
			p.createEl('a', { text: commitUrl.split('/tree/')[1]?.slice(0, 7) ?? 'remote', href: commitUrl });
			p.createSpan({ text: ' on GitHub' });
		}

		if (statusNote) {
			contentEl.createEl('p', { text: statusNote, cls: 'fit-status-note' });
		}

		if (autoSyncNote) {
			contentEl.createEl('p', { text: autoSyncNote, cls: 'fit-autosync-note' });
		}

		if (sections.length > 0) {
			const ul = contentEl.createEl('ul', { cls: 'fit-status-list' });
			for (const section of sections) {
				const groupLi = ul.createEl('li', { cls: 'fit-status-group' });
				const details = groupLi.createEl('details');
				details.createEl('summary', { text: section.heading, cls: 'fit-status-group-label' });
				if (section.description) {
					details.createEl('p', { text: section.description, cls: 'fit-status-group-desc' });
				}
				for (const item of section.items) {
					const li = ul.createEl('li', { cls: `file-update-row ${item.cls}` });
					const tooltip = FILE_TOOLTIP[item.cls];
					if (tooltip) li.setAttribute('title', tooltip);
					li.createSpan({ text: item.path });
					if (item.detail) {
						li.createSpan({ text: item.detail, cls: 'fit-file-detail' });
					}
				}
			}
		}

		if (scanNote) {
			contentEl.createEl('p', { text: scanNote, cls: 'fit-scan-note' });
		}

		const hasObsidianItems = sections.some(s => s.items.some(i => i.path.startsWith('.obsidian/')));
		if (!hasObsidianItems) {
			const infoP = contentEl.createEl('p', { cls: 'fit-info-note' });
			infoP.createEl('code', { text: '.obsidian/' });
			infoP.createSpan({ text: ' files are not synced by default. Configure in Settings → Obsidian config sync.' });
		}

		this.checkFieldWarnings();
	}

	private async checkFieldWarnings() {
		const pendingLocalPaths = new Set(
			this.renderable.sections
				.flatMap(s => s.items)
				.filter(i => i.cls === 'file-ADDED' || i.cls === 'file-MODIFIED' || i.cls === 'file-REMOVED')
				.map(i => i.path)
		);

		const warnings: { path: string; newFields: string[] }[] = [];

		for (const [fullPath, rule] of Object.entries(this.obsidianSyncRules)) {
			if (!rule.fields) continue;
			if (!pendingLocalPaths.has(fullPath)) continue;
			try {
				const text = await this.app.vault.adapter.read(fullPath);
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					const newFields = findNewFields(rule.fields, Object.keys(parsed));
					if (newFields.length > 0) {
						warnings.push({ path: fullPath, newFields });
					}
				}
			} catch {
				// file missing or not JSON — skip
			}
		}

		if (warnings.length === 0) return;
		// Guard: modal may have been closed while awaiting
		if (!this.containerEl.isConnected) return;

		const section = this.contentEl.createDiv({ cls: 'fit-field-warning-section' });
		section.createEl('p', {
			text: 'New fields detected in synced config files — these will sync on next run:',
			cls: 'fit-field-warning-heading',
		});
		const ul = section.createEl('ul', { cls: 'fit-field-warning-list' });
		for (const { path, newFields } of warnings) {
			const li = ul.createEl('li');
			li.createEl('code', { text: path });
			li.createSpan({ text: ': ' });
			newFields.forEach((f, i) => {
				if (i > 0) li.createSpan({ text: ', ' });
				li.createEl('code', { text: f, cls: 'fit-field-warning-field' });
			});
		}
		const hint = section.createEl('p', { cls: 'fit-field-warning-hint' });
		hint.createSpan({ text: 'Consider removing the file from sync in Settings → Obsidian config sync until field-level controls are available (' });
		hint.createEl('a', { text: 'issue #67', href: 'https://github.com/joshuakto/fit/issues/67' });
		hint.createSpan({ text: ').' });
	}

	onClose() {
		this.contentEl.empty();
	}
}
