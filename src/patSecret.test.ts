import { describe, it, expect } from 'vitest';
import { PAT_SECRET_BASE_NAME, readPat, storeLegacyPat } from './patSecret';
import { FakeSecretStorage } from './testUtils';

describe('storeLegacyPat', () => {
	it('given an empty store, should store the token under the base name', () => {
		const store = new FakeSecretStorage();
		expect(storeLegacyPat(store, 'ghp_a')).toBe(PAT_SECRET_BASE_NAME);
		expect(store.getSecret(PAT_SECRET_BASE_NAME)).toBe('ghp_a');
	});

	it('given the base name already holds the same token, should reuse it', () => {
		const store = new FakeSecretStorage({ [PAT_SECRET_BASE_NAME]: 'ghp_a' });
		expect(storeLegacyPat(store, 'ghp_a')).toBe(PAT_SECRET_BASE_NAME);
		expect(store.listSecrets()).toEqual([PAT_SECRET_BASE_NAME]);
	});

	it('given the base name holds a different token (another vault), should leave it and use the next free name', () => {
		const store = new FakeSecretStorage({ [PAT_SECRET_BASE_NAME]: 'ghp_other' });
		expect(storeLegacyPat(store, 'ghp_a')).toBe(`${PAT_SECRET_BASE_NAME}-2`);
		expect(store.getSecret(PAT_SECRET_BASE_NAME)).toBe('ghp_other');
		expect(store.getSecret(`${PAT_SECRET_BASE_NAME}-2`)).toBe('ghp_a');
	});

	it('given the store rejects writes, should return null', () => {
		const store = new FakeSecretStorage();
		store.failWrites = true;
		expect(storeLegacyPat(store, 'ghp_a')).toBeNull();
	});

	it('given the store does not return what was written, should return null', () => {
		const store = new FakeSecretStorage();
		store.setSecret = () => {};
		expect(storeLegacyPat(store, 'ghp_a')).toBeNull();
	});
});

describe('readPat', () => {
	it.each([
		['a stored secret', 'my-token', 'ghp_a'],
		['a name with no secret', 'missing', ''],
		['no name', '', ''],
	])('given %s, should return the token or an empty string', (_label, name, expected) => {
		const store = new FakeSecretStorage({ 'my-token': 'ghp_a' });
		expect(readPat(store, name)).toBe(expected);
	});
});
