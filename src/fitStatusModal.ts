/**
 * Obsidian modal UI for the "Explain Sync Status" command.
 * Receives a RenderableExplanation from fitStatusExplainer.ts and renders it.
 */

import { App, Modal } from 'obsidian';
import type { RenderableExplanation } from '@/fitStatusExplainer';

const FILE_TOOLTIP: Record<string, string> = {
	'file-needs-resolution': 'Conflict — review or delete the _fit/ counterpart, then sync again. Hidden files (starting with .) won\'t appear in Obsidian\'s file explorer; use a desktop file manager.',
	'file-ADDED':            'Added locally — will push on next sync.',
	'file-MODIFIED':         'Modified locally — will push on next sync.',
	'file-REMOVED':          'Deleted locally — will push on next sync.',
	'file-push-skipped':     'Exceeds GitHub file size limit — reduce size or remove to sync.',
};

/**
 * Modal shown by the "Explain Sync Status" command.
 * Renders a {@link RenderableExplanation} (from {@link renderExplanation}) and
 * asynchronously checks synced .obsidian/ files for new fields not in the stored
 * rule.fields snapshot, warning the user if any appear.
 */
export class FitStatusModal extends Modal {
	private renderable: RenderableExplanation;

	constructor(app: App, renderable: RenderableExplanation) {
		super(app);
		this.renderable = renderable;
	}

	onOpen() {
		const { contentEl } = this;
		const { title, commitUrl, statusNote, autoSyncNote, sections, scanNote, fitAttributesNote } = this.renderable;

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

		if (fitAttributesNote) {
			contentEl.createEl('p', { text: fitAttributesNote, cls: 'fit-fitattributes-note' });
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
			infoP.createSpan({ text: ' files start being tracked once their content exists in your GitHub repo, but a tracked file only actually syncs once you add a ' });
			infoP.createEl('code', { text: '.fitattributes.json' });
			infoP.createSpan({ text: ' entry (format: "text") for it at your vault root.' });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
