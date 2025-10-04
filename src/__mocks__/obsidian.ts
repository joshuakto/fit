export const arrayBufferToBase64 = jest.fn((buffer: ArrayBuffer) => {
	return btoa(String.fromCharCode(...new Uint8Array(buffer)));
});

export class TFile {
	path!: string;
	name!: string;
	extension!: string;
	basename!: string;
}

export class Vault {
	readBinary = jest.fn();
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
