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
 * Compute SHA-1 hash of content.
 * Generic SHA-1 helper used for git-like blob hashing and file content comparison.
 *
 * NOTE: this content hashing doesn't exactly match git's and doesn't need to. It just needs to
 * remain consistent with previous hashes of the same file/content.
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
