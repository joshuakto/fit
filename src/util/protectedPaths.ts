/**
 * Hard denylist for `.obsidian/` paths — content never fetched or inspected
 * regardless of git content (git-as-mask, see docs/sync-logic.md § Protected Paths).
 * The path itself may still be named in diagnostic logs to explain the exclusion
 * (see `Fit.classifyObsidianPathsForLog`'s `hardDenylisted` bucket) — only its
 * content is off-limits.
 */

const PLUGIN_MANAGED_ASSET = /^\.obsidian\/plugins\/[^/]+\/(main\.js|manifest\.json|styles\.css)$/;

/**
 * Hard, git-content-independent denylist. A denylisted path's content is never
 * fetched or inspected — enforced independently of `Fit.shouldSyncPath`, belt and
 * suspenders for the one invariant that must never regress.
 *
 * FIT's own data.json and plugin-managed code assets are denylisted for different
 * reasons, not the same one:
 * - Plugin-managed assets (main.js/manifest.json/styles.css) are permanent — owned by
 *   Obsidian's plugin loader, not a preferences file, no "safe subset of fields"
 *   concept ever applies.
 * - FIT's own data.json mixes genuinely shareable preferences (autoSync,
 *   notifyChanges, ...) with per-device sync bookkeeping that would be destructive to
 *   sync (localShas, lastFetchedCommitSha, pendingClashes, ...) and a secret (pat).
 *   It's blocked at the whole-file level here only because whole-file/text-mode sync
 *   has no field granularity to isolate the two — a candidate to become a narrow
 *   format:"json" opt-in later once field-level masking exists, at which point pat/
 *   localShas/etc still need their own field-level denylist independent of whatever
 *   .fitattributes.json configures.
 */
export function isHardDenylistedObsidianPath(path: string, ownDataPath: string | null): boolean {
	if (ownDataPath && path === ownDataPath) return true;
	if (path === ".obsidian/plugins/fit/data.json") return true;
	return PLUGIN_MANAGED_ASSET.test(path);
}
