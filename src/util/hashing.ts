/**
 * Utils for working with git-like SHAs and hashing.
 */

export type BlobSha = string & { readonly __brand: 'Blob' };

export type CommitSha = string & { readonly __brand: 'Commit' };

export type TreeSha = string & { readonly __brand: 'Tree' };

/**
 * Git's well-known empty tree SHA - represents a tree with no files
 * This is a constant in Git that always represents an empty tree
 * GitHub API returns 404 when trying to fetch this SHA, so we handle it specially
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as TreeSha;

/**
 * Compute canonical Git blob SHA-1 for file content.
 *
 * Matches GitHub's blob SHA format: SHA1("blob " + byteLength + NUL + rawBytes).
 * With canonical SHAs, local and remote SHAs are directly comparable.
 *
 * @param rawBytes - Raw file bytes (not base64, not text-decoded)
 * @returns Hex-encoded SHA-1 hash
 */
export async function computeGitBlobSha(rawBytes: Uint8Array): Promise<BlobSha> {
	const header = new TextEncoder().encode(`blob ${rawBytes.length}\0`);
	const data = new Uint8Array(header.length + rawBytes.length);
	data.set(header);
	data.set(rawBytes, header.length);
	const hashBuf = await crypto.subtle.digest('SHA-1', data);
	return Array.from(new Uint8Array(hashBuf))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('') as BlobSha;
}

/**
 * Compute SHA-1 hash of a string.
 * Used internally for legacy local SHA (path + content) and commit/tree SHAs in tests.
 *
 * @param content - String content to hash
 * @returns Hex-encoded SHA-1 hash
 */
export async function computeSha1(content: string): Promise<string> {
	const enc = new TextEncoder();
	const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(content));
	const hashArray = Array.from(new Uint8Array(hashBuf));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}
