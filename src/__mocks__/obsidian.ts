import { vi } from 'vitest';

export const arrayBufferToBase64 = vi.fn((buffer: ArrayBuffer) => {
	// Mock of Obsidian's native arrayBufferToBase64 function.
	// Real implementation is in C++ and highly optimized.
	// This mock processes in chunks for reasonable test performance while avoiding
	// the "Maximum call stack size exceeded" issue from PR #127.
	const bytes = new Uint8Array(buffer);
	const CHUNK_SIZE = 0x8000; // 32KB chunks - small enough to avoid stack overflow
	const chunks = [];
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
		// String.fromCharCode.apply() is much faster than char-by-char concatenation.
		// Uses apply with small chunks to avoid the original PR #127 issue.
		chunks.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
	}
	return btoa(chunks.join(''));
});

export const base64ToArrayBuffer = vi.fn((base64: string) => {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
});

export class TFile {
	path!: string;
	name!: string;
	extension!: string;
	basename!: string;
}

export class TFolder {
	path!: string;
	children: any[] = [];
}

export class Vault {
	readBinary = vi.fn();
	cachedRead = vi.fn();
}

export class Component {
	load = vi.fn();
	unload = vi.fn();
}

export class Notice {
	constructor(message: string) {}
	setMessage = vi.fn();
	hide = vi.fn();
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
};

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: HTMLElement = document.createElement('div');

	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
	}

	display() {}
	hide() {}
}
