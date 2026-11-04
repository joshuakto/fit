/**
 * Hard denylist for `.obsidian/` paths — content never fetched or inspected
 * regardless of git content (git-as-mask, see docs/sync-logic.md § Protected Paths).
 * The path itself may still be named in diagnostic logs to explain the exclusion
 * (see `Fit.classifyObsidianPathsForLog`'s `hardDenylisted` bucket) — only its
 * content is off-limits.
 */

// Internal cache directories in .obsidian/ that should never sync across devices
const OBSIDIAN_CACHE_FILES = /^\.obsidian\/\.?cache(\/.*)?$/;

// VCS metadata directories checked into plugin folders
const PLUGIN_VCS_DIRS = /^\.obsidian\/plugins\/[^/]+\/\.(git|github)(\/.*)?$/;

// A plugin dev's own node_modules/ checked into their plugin dir — never something anyone
// intends to track/push, scoped to plugin dirs specifically (not a blanket anywhere-in-vault
// match, which would misfire on a legitimately-named vault folder or note). Both regexes
// below derive from the same root pattern so the sync-time exclusion and the scan-time
// pruning root (`isPluginNodeModulesRoot`) can't drift apart.
const PLUGIN_NODE_MODULES_ROOT_SOURCE = String.raw`^\.obsidian\/plugins\/[^/]+\/node_modules`;
const PLUGIN_NODE_MODULES = new RegExp(`${PLUGIN_NODE_MODULES_ROOT_SOURCE}\\/`);
const PLUGIN_NODE_MODULES_ROOT = new RegExp(`${PLUGIN_NODE_MODULES_ROOT_SOURCE}$`);

function isFitOwnAsset(path: string, ownPluginDir: string): boolean {
	if (!path.startsWith(`${ownPluginDir}/`)) return false;
	const subpath = path.slice(ownPluginDir.length + 1);
	if (/^(main\.js|manifest\.json|styles\.css)$/.test(subpath)) return true;
	if (/^debug\.log(\..*)?$/.test(subpath)) return true;
	return false;
}

/**
 * Hard, git-content-independent denylist — content never fetched or inspected,
 * enforced independently of `Fit.shouldSyncPath`.
 *
 * Excludes:
 * - FIT's own runtime assets (main.js, manifest.json, styles.css, debug logs), protecting
 *   the running plugin from self-overwrite while allowing its data.json to sync via subset masking.
 * - Plugin node_modules/ and VCS metadata (.git, .github).
 * - Obsidian cache directories.
 *
 * Community plugins (main.js, manifest.json, styles.css, data.json) outside FIT itself
 * are sync-eligible.
 */
export function isHardDenylistedObsidianPath(path: string, ownPluginDir?: string | null): boolean {
	const fitDir = ownPluginDir || '.obsidian/plugins/fit';
	if (isFitOwnAsset(path, fitDir)) return true;
	return (
		PLUGIN_NODE_MODULES.test(path) ||
		PLUGIN_VCS_DIRS.test(path) ||
		OBSIDIAN_CACHE_FILES.test(path)
	);
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
 * - `patSecretName` is a different case: not sensitive, but each device picks its own secret
 *   name and the secret's value is never synced, so overwriting the name with another device's
 *   would only point at a secret that may not exist there.
 *
 * When adding a field to `FitSettings` (src/fitSettings.ts) or `LocalStores`
 * (src/localStores.ts), list it here only if syncing it is logically unsafe (it would redirect or
 * corrupt another device) or uniquely disruptive and unhelpful (like `patSecretName` above).
 * Being device-specific is not enough on its own; secrets belong in
 * `UNIVERSAL_SECRET_FIELD_DENYLIST`.
 */
export const FIT_OWN_SETTINGS_DENYLIST = [
	// FitSettings — connection/device identity
	"githubHost",
	"owner",
	"avatarUrl",
	"repo",
	"branch",
	"deviceName",
	// FitSettings — per-device pointer to the token's secret
	"patSecretName",
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
