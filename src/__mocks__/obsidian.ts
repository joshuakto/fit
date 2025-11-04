export const arrayBufferToBase64 = jest.fn((buffer: ArrayBuffer) => {
	return btoa(String.fromCharCode(...new Uint8Array(buffer)));
});

export const base64ToArrayBuffer = jest.fn((base64: string) => {
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
	readBinary = jest.fn();
	cachedRead = jest.fn();
}

export class Component {
	load = jest.fn();
	unload = jest.fn();
}

export class Notice {
	constructor(message: string) {}
	setMessage = jest.fn();
	hide = jest.fn();
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
};
