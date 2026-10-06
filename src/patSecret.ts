/**
 * The GitHub token lives in Obsidian's secret storage, not in data.json. Settings keep only the
 * secret's name (`patSecretName`); `FitSettings.pat` holds the resolved value at runtime and is
 * never persisted.
 */

/** The slice of Obsidian's `SecretStorage` (1.11.4+) used here. */
export interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	listSecrets(): string[];
}

export const PAT_SECRET_BASE_NAME = 'fit-github-pat';

/**
 * Moves a plaintext token from an older version's data.json into secret storage and returns the
 * secret's name, or null if it could not be stored and read back (the caller then keeps the
 * plaintext, so nothing is lost and the next load retries).
 *
 * Secrets are shared across vaults, so a name already holding a different value is skipped
 * rather than overwritten.
 */
export function storeLegacyPat(store: SecretStore, pat: string): string | null {
	const existing = new Set(store.listSecrets());
	for (let n = 1; ; n++) {
		const name = n === 1 ? PAT_SECRET_BASE_NAME : `${PAT_SECRET_BASE_NAME}-${n}`;
		if (existing.has(name) && store.getSecret(name) !== pat) continue;
		try {
			store.setSecret(name, pat);
			return store.getSecret(name) === pat ? name : null;
		} catch {
			return null;
		}
	}
}

export function readPat(store: SecretStore, secretName: string): string {
	return secretName ? store.getSecret(secretName) ?? '' : '';
}
