/**
 * LocalStores — the persisted sync state contract.
 *
 * Kept in its own module (no Obsidian imports) so it can be unit-tested directly.
 * main.ts owns loading/saving; fitSync.ts owns mutation during sync.
 */
import { CommitSha } from '@/util/hashing';
import { FileStates } from '@/util/changeTracking';

export interface LocalStores {
	localShas: FileStates                  // Canonical git blob SHA cache (primary)
	// SHAs here use a legacy formula (SHA1(path + content)) that differs from canonical git blob SHA,
	// with content encoded as base64 for png/jpg/jpeg/pdf and as plaintext for everything else.
	// Downgrade notice: old client versions may find this field missing and see spurious local file
	// changes, but those trigger re-upload overhead only and rarely clash unless the same files were
	// also updated on remote during the same sync.
	localSha?: FileStates                  // Legacy path+content SHA cache (migration source only)
	lastFetchedCommitSha: CommitSha | null // Last synced commit
	lastFetchedRemoteShas: FileStates      // Canonical remote SHA cache
	lastFetchedRemoteSha?: FileStates      // Legacy field name — read-only fallback when loading old data
	// Files that were skipped due to GitHub API size limits (422) and haven't reached
	// remote yet. Maps path → SHA at time of skip, so we can detect when the file
	// has been modified locally (and should re-enter the normal sync queue) or reconciled
	// on remote (and should be removed from this list).
	// Note: transient failures like rate limits (#179) should be tracked separately when needed since they SHOULD retry on subsequent syncs.
	unpushedFiles?: FileStates
	// Paths with an unresolved _fit/ copy (pending clash state). localShas entry is absent
	// for these paths. Resolved when _fit/ is deleted or matches local content.
	// Downgrade-safe: absent field treated as empty array; missing localShas entry causes
	// false-positive re-push on old clients (overhead only, not data loss).
	pendingClashes?: string[]
}

/**
 * Deserialize raw stored data into a typed LocalStores object.
 * Pure function — no Obsidian dependency — so it can be unit-tested directly.
 * Every field in LocalStores must appear here with an appropriate default.
 *
 * Adding a field checklist:
 *   1. Add to LocalStores interface above with a ?? default here
 *   2. Add to saveLocalStoreCallback in fitSync.ts
 *   3. Add a round-trip assertion in localStores.test.ts
 */
export function parseLocalStore(data: Record<string, unknown> | null | undefined): LocalStores {
	const d = data ?? {};
	return {
		localShas: (d.localShas ?? {}) as unknown as FileStates,
		localSha: d.localSha as unknown as FileStates | undefined,  // undefined if absent → omitted by JSON.stringify
		lastFetchedCommitSha: (d.lastFetchedCommitSha ?? null) as unknown as CommitSha | null,
		lastFetchedRemoteShas: (d.lastFetchedRemoteSha ?? d.lastFetchedRemoteShas ?? {}) as unknown as FileStates,
		lastFetchedRemoteSha: undefined,               // consume legacy field → omitted by JSON.stringify
		unpushedFiles: (d.unpushedFiles ?? {}) as unknown as FileStates,
		pendingClashes: (d.pendingClashes ?? []) as unknown as string[],
	};
}
