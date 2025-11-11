import { vi } from 'vitest';

export const arrayBufferToBase64 = vi.fn((buffer: ArrayBuffer) => {
	return btoa(String.fromCharCode(...new Uint8Array(buffer)));
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
