import FitPlugin from "@main";
import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export let plugin: FitPlugin;

export function init(p: FitPlugin) {
	plugin = p;
}

export function isEnabled(): boolean {
	// If this is a test, disable encryption and prevent
	// errors due to an uninitialized `plugin`
	if (process.env.NODE_ENV === 'test') return false;
	return plugin.settings.encryptionPassword !== "";
}

async function getMasterKey(password: string): Promise<CryptoKey> {
	const baseKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return baseKey;
}

type CryptoKeyUsage = "encrypt" | "decrypt";

async function deriveKey(usage: CryptoKeyUsage): Promise<CryptoKey> {
	if (!isEnabled()) throw new Error("The encryption is not enabled so the password is empty.");
	const masterKey = await getMasterKey(plugin.settings.encryptionPassword);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: encoder.encode("salt"),
			iterations: 100000,
			hash: "SHA-256",
		},
		masterKey,
		{ name: "AES-GCM", length: 256 },
		false,
		[usage],
	);
}

let cache: Record<CryptoKeyUsage, CryptoKey | null> = {
	encrypt: null,
	decrypt: null
};

async function getCachedDerivedKey(usage: CryptoKeyUsage): Promise<CryptoKey> {
	if (cache[usage] === null) {
		cache[usage] = await deriveKey(usage);
		return cache[usage];
	}
	return cache[usage];
}

export function clearCache() {
	cache = {
		encrypt: null,
		decrypt: null,
	};
}

export async function encryptContent(content: string): Promise<string> {
	const key = await getCachedDerivedKey("encrypt");
	const iv = crypto.getRandomValues(new Uint8Array(12));

	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoder.encode(content),
	);

	const combined = new Uint8Array(iv.length + encrypted.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(encrypted), iv.length);

	return arrayBufferToBase64(combined.buffer);
}

export async function decryptContent(encryptedContent: string): Promise<string> {
	const key = await getCachedDerivedKey("decrypt");
	const combined = new Uint8Array(base64ToArrayBuffer(encryptedContent));
	const iv = combined.slice(0, 12);
	const data = combined.slice(12);

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		data,
	);

	return decoder.decode(decrypted);
}

export async function encryptPath(path: string): Promise<string> {
	const key = await getCachedDerivedKey("encrypt");
	const segments = path.split("/");

	const encryptedSegments = await Promise.all(
		segments.map(async (seg) => {
			if (!seg) return "";
			const fixedIv = new Uint8Array(12).fill(0);

			const encrypted = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv: fixedIv },
				key,
				encoder.encode(seg),
			);

			return arrayBufferToBase64(encrypted)
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		}),
	);

	return encryptedSegments.join("/");
}

export async function decryptPath(encryptedPath: string): Promise<string> {
	const key = await getCachedDerivedKey("decrypt");
	const segments = encryptedPath.split("/");

	const decryptedSegments = await Promise.all(
		segments.map(async (seg) => {
			if (!seg) return "";
			const base64 = seg.replace(/-/g, "+").replace(/_/g, "/");
			const paddedBase64 = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
			const data = base64ToArrayBuffer(paddedBase64);
			const fixedIv = new Uint8Array(12).fill(0);

			const decrypted = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: fixedIv },
				key,
				data,
			);

			return decoder.decode(decrypted);
		}),
	);

	return decryptedSegments.join("/");
}
