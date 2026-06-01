import { App, Modal } from 'obsidian';
import type { RenderableExplanation } from '@/fitStatusExplainer';

const FILE_TOOLTIP: Record<string, string> = {
	'file-needs-resolution': 'Conflict — review or delete the _fit/ counterpart, then sync again.',
	'file-ADDED':            'Added locally — will push on next sync.',
	'file-MODIFIED':         'Modified locally — will push on next sync.',
	'file-REMOVED':          'Deleted locally — will push on next sync.',
	'file-push-skipped':     'Exceeds GitHub file size limit — reduce size or remove to sync.',
};

export class FitStatusModal extends Modal {
	private renderable: RenderableExplanation;

	constructor(app: App, renderable: RenderableExplanation) {
		super(app);
		this.renderable = renderable;
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

		const infoP = contentEl.createEl('p', { cls: 'fit-info-note' });
		infoP.createSpan({ text: 'Hidden files (starting with ' });
		infoP.createEl('code', { text: '.' });
		infoP.createSpan({ text: ') and ' });
		infoP.createEl('code', { text: '.obsidian/' });
		infoP.createSpan({ text: ' are excluded from sync. Support for these is planned — see issues ' });
		infoP.createEl('a', { text: '#92', href: 'https://github.com/joshuakto/fit/issues/92' });
		infoP.createSpan({ text: ' and ' });
		infoP.createEl('a', { text: '#67', href: 'https://github.com/joshuakto/fit/issues/67' });
		infoP.createSpan({ text: '.' });
	}

	onClose() {
		this.contentEl.empty();
	}
}
