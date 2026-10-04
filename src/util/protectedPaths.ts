/**
 * Hard denylist for `.obsidian/` paths — content never fetched or inspected
 * regardless of git content (git-as-mask, see docs/sync-logic.md § Protected Paths).
 * The path itself may still be named in diagnostic logs to explain the exclusion
 * (see `Fit.classifyObsidianPathsForLog`'s `hardDenylisted` bucket) — only its
 * content is off-limits.
 */

const PLUGIN_MANAGED_ASSET = /^\.obsidian\/plugins\/[^/]+\/(main\.js|manifest\.json|styles\.css)$/;

// A plugin dev's own node_modules/ checked into their plugin dir — never something anyone
// intends to track/push, scoped to plugin dirs specifically (not a blanket anywhere-in-vault
// match, which would misfire on a legitimately-named vault folder or note). Both regexes
// below derive from the same root pattern so the sync-time exclusion and the scan-time
// pruning root (`isPluginNodeModulesRoot`) can't drift apart.
const PLUGIN_NODE_MODULES_ROOT_SOURCE = String.raw`^\.obsidian\/plugins\/[^/]+\/node_modules`;
const PLUGIN_NODE_MODULES = new RegExp(`${PLUGIN_NODE_MODULES_ROOT_SOURCE}\\/`);
const PLUGIN_NODE_MODULES_ROOT = new RegExp(`${PLUGIN_NODE_MODULES_ROOT_SOURCE}$`);

/**
 * Hard, git-content-independent denylist — content never fetched or inspected,
 * enforced independently of `Fit.shouldSyncPath`. Plugin-managed assets
 * (main.js/manifest.json/styles.css) are permanent: owned by Obsidian's plugin loader,
 * no "safe subset of fields" concept applies. FIT's own data.json is NOT here — see
 * `FIT_OWN_SETTINGS_DENYLIST` below, its field denylist instead.
 */
export function isHardDenylistedObsidianPath(path: string): boolean {
	return PLUGIN_MANAGED_ASSET.test(path) || PLUGIN_NODE_MODULES.test(path);
}

/**
 * Whether `path` is itself a plugin's `node_modules` root folder (no trailing slash, as
 * `DataAdapter.list()`'s `folders` entries are shaped) — used by the hidden-path scan
 * (`LocalVault`) to prune recursion into it. `isHardDenylistedObsidianPath` tests file
 * paths *under* the root and remains the sync gate however a path was discovered (local
 * scan, tracked-path probe, or remote tree state); this only keeps the scan from walking in.
 */
export function isPluginNodeModulesRoot(path: string): boolean {
	return PLUGIN_NODE_MODULES_ROOT.test(path);
}

/**
 * Field names denylisted on every `scope: "subset"` path, not just FIT's own data.json
 * — applied by `FitSync.resolveSubsetScopePath` before anything downstream can see them.
 * A field literally named `pat` turning up in some other tracked `.obsidian/*.json` file
 * (typo, copy-paste) is worth stripping unconditionally, regardless of which file it's in.
 */
export const UNIVERSAL_SECRET_FIELD_DENYLIST = [
	"pat",
	"encryptionPassword",
] as const;

/**
 * Additional unsafe-to-sync fields for FIT's own data.json specifically (`Fit.ownDataPath`
 * — resolved dynamically from the plugin's actual install dir, e.g.
 * `.obsidian/plugins/fit-dev/data.json`). Unioned with `UNIVERSAL_SECRET_FIELD_DENYLIST`
 * at the filtering site (`pat` isn't repeated here). Two reasons these are unsafe:
 * - Connection/device identity (`githubHost`, `owner`, `avatarUrl`, `repo`, `branch`,
 *   `deviceName`) — owner/repo/branch identify the sync target itself (see
 *   docs/sync-logic.md § Protected Paths). Plausible opt-in candidate later, no such
 *   mechanism exists today.
 * - All of `LocalStores` (`localShas`, `pendingClashes`, ...) — per-device sync state,
 *   meaningless (corrupting) on any other device by construction. Never an opt-in candidate.
 *
 * Keep in sync with `FitSettings` (src/fitSettings.ts) and `LocalStores` (src/localStores.ts).
 */
export const FIT_OWN_SETTINGS_DENYLIST = [
	// FitSettings — connection/device identity
	"githubHost",
	"owner",
	"avatarUrl",
	"repo",
	"branch",
	"deviceName",
	// LocalStores — per-device sync bookkeeping
	"localShas",
	"localSha",
	"lastFetchedCommitSha",
	"lastFetchedRemoteShas",
	"lastFetchedRemoteSha",
	"unpushedFiles",
	"pendingClashes",
	"lastSyncedAt",
	"protectedPathShas",
	// No longer a LocalStores field; kept so a stale value in an old data.json never syncs.
	"pendingUntrackedPaths",
] as const;
