# Sync performance inventory

In-depth performance analysis of FIT's sync operations, grounded in extreme worked examples (a
1,000-file first sync, a 150 MB file, a deeply-nested plugin directory) rather than abstract
complexity claims. Tracks call/operation counts and cost shape, not absolute latency - real-world
speed depends heavily on device, OS, and network, which vary too much to pin down here. The goal
is to make today's actual performance characteristics concrete enough that a new risk introduced
as the code evolves stands out by contrast, instead of blending into vague "could be slow
somewhere" intuition.

See [sync-logic.md](./sync-logic.md), § Performance Characteristics, for the general prose
description this doc gives concrete numbers for. See
[Sync Scenario Matrix](./sync-scenario-matrix.md) for the correctness counterpart - a mechanism
can be ✅ there and still scale badly here.

## Method

Each row states what the operation scales with, its real complexity (verified against the actual
code path, not assumed), and a worked example converting that into a concrete number for a stated
scenario size - "O(N)" alone doesn't answer "how many requests does a 1,000-file first sync
send," a row here should.

## Network cost: GitHub API calls

| Operation | Scales with | Complexity | Worked example |
|---|---|---|---|
| Remote tree fetch (`getTree`, whole-repo state) | Total repo file count | **O(1) API calls** - one `GET .../git/trees/{sha}?recursive=true` returns the entire tree in one response, regardless of file count. Response payload size is O(N). | A 1,000-file vault: 1 API call, ~1,000-entry JSON response. |
| Push N changed files (`applyChanges`) | Number of files actually changed *this sync*, not vault size | **O(N) API calls**: one `POST .../git/blobs` per file (no bulk-blob endpoint exists), run in parallel, plus O(1) `createTree` + `createCommit` + ref-update calls | A brand-new 1,000-file vault's first sync: ~1,000 blob-creation POSTs + 3 calls (tree, commit, ref update) ≈ **1,003 API calls total.** Pushing a 5-file incremental edit: ~8 calls. |
| Pull N changed files (`readFileContent` per path) | Number of files needing content *this sync* | **O(N) API calls**: one `GET .../git/blobs/{sha}` per file - the tree fetch above returns paths and SHAs, not content, so each file's bytes still costs its own call | Pulling 1,000 newly-added remote files: ~1,000 GET calls. Pulling a 5-file incremental change: 5 calls. |
| JSON-merge/text-mode clash base-blob fetch (`jsonBaseTexts` covers any `format:"json"` path, not just `.canvas`; diff3 base fetch covers everything else) | Number of clashed paths *this sync* (K), independent of N | **O(K) extra API calls** on top of the pull cost above - one extra `GET .../git/blobs/{sha}` per clashed path to fetch the 3-way-merge base | 5 clashes in a sync: +5 API calls beyond the ordinary pull cost. K is typically ≪ N (clashes are the exception). |
| Remote `.fitattributes.json` fetch (`resolveRemoteFitAttributes`) | Nothing - fixed cost | **O(1) extra GET blob**, every sync unconditionally, even for a vault with zero `.obsidian/` paths tracked | Every sync: +1 API call beyond the tree fetch, whether or not any subset-scope path exists. |
| `.obsidian/` cross-device rule-disagreement content check (`needsMaskedOverlayForPull`, gates `contentCheckCandidates`) | Number of changed `.obsidian/*.json` paths this sync whose *local* rule doesn't already resolve to `format:"json"`/`scope:"subset"` | **O(M) extra GET blob fetches**, M = that changed-path count - one remote `readFileContent` per candidate, independent of and in addition to whatever fetch the normal opaque-pull pipeline does for the same path if the check comes back `false` (masking not needed) | A sync where 3 `.obsidian/` paths changed remotely and none are locally subset-scoped: 3 extra GETs, on top of the 3 the normal pipeline needs anyway to actually pull them. |
| `.obsidian/` subset-scope path resolution, remote content read (`resolveSubsetScopePath`, one call per candidate; runs every sync, unconditionally, no SHA-based skip - see [sync-logic.md](./sync-logic.md) § `.fitattributes.json`, Known limitations) | Number of tracked `scope:"subset"` `.obsidian/` paths (candidates), independent of whether any of them actually changed | **O(candidates) GET blob fetches every sync** - re-fetches remote content for every tracked subset-scope path regardless of SHA match. A path that also passed the content check above (M above) is fetched a *second* time here - the check and the resolution don't share the read. | 20 tracked `.obsidian/*.json` paths (typical for a vault with several plugins configured): 20 GETs every sync, even if none changed since last time. |
| `.obsidian/` subset-scope clash 3-way-merge base fetch (`resolveSubsetScopePath`'s own `readFileBlobBySha(priorRemoteSha)` call) | Number of subset-scope paths clashing this sync (K'), independent of N | **O(K') extra GET blob fetches** - a separate mechanism from the `jsonBaseTexts` row above (same *kind* of cost, different code path, not counted in that row's K) | 2 subset-scope clashes in a sync: +2 API calls beyond the per-candidate fetch above. |

## Local cost: filesystem scan and SHA computation

Every sync, before any network call, `LocalVault.readFromSource()` scans and hashes local files -
CPU/disk cost, no network involved, but explicitly called out in the code itself as a mobile
crash risk (`localVault.ts`'s own comment: "Monitor for slow operations that could cause mobile
crashes").

| Operation | Scales with | Complexity | Worked example |
|---|---|---|---|
| SHA computation over tracked files (`LocalVault.fileSha1`, one SHA-1 per file) | Local file count **and** total bytes read (SHA-1 is computed over full file content, not just metadata) | **O(N) file reads, O(total bytes) hashing work**, run in parallel (`Promise.allSettled`), monitored via `withSlowOperationMonitoring` with a 10-second warn threshold | 1,000 small files: fast, well under 10s on desktop, may approach it on mobile (the actual documented threshold: "hundreds of files on mobile" in § Performance Characteristics). One 500 MB file: dominated by hashing that single file's bytes, not file count at all. |
| Hidden-path discovery scan (`scanHiddenPaths`, only when "Sync hidden files" is enabled) | Total vault size (recursive directory walk via `vault.adapter`, bypassing Obsidian's index) | **O(vault size) extra traversal**, on top of (not instead of) the ordinary `vault.getFiles()` index read - effectively doubles local traversal cost while the setting is on | A vault with deeply nested plugin directories (`.obsidian/plugins/*/node_modules/...`): this scan walks all of it. |
| Tracked-`.obsidian/`-path probing when "Sync hidden files" is **disabled** (`trackedHiddenPaths` stat loop, `LocalVault.readFromSource`) | Number of already-tracked `.obsidian/` paths (`Fit.trackedObsidianPaths()`, both `format:"text"` and `scope:"subset"` paths) | **O(tracked-path count) extra `adapter.stat()` calls every sync**, bypassing the (skipped) recursive scan to individually probe each already-tracked path - predates subset-scope masking (#67), but subset-scope tracks one path per masked `.obsidian/*.json` file (not one per plugin), so this set grows faster than it used to as more granular JSON files get tracked | A vault with 20 tracked `.obsidian/` paths (several plugins' JSON configs, each masked separately): 20 extra `stat()` calls every sync even with hidden-file sync off. |

This scan's paths also feed a real, confirmed logging problem: `LocalVault.readFromSource()` logs
the *entire* matching path array every sync (hidden paths, untracked paths, gitignore-ignored
paths, three separate call sites), unconditionally - `sanitizeForLogging` (`src/logger.ts`)
truncates long strings but maps over arrays with no length cap at all. Confirmed in practice: a
real vault with "Sync hidden files" enabled and several nested plugin directories logged 12,000+
path entries in a single sync's debug output.

## Per-file size, not file count

The two sections above characterize *how many* files/requests. This is the orthogonal axis: what
happens to *one very large* file, on either side of the previous tables.

- **GitHub's hard limit is 100 MB per blob** (`GITHUB_SIZE_LIMIT = 100 * 1024 * 1024` bytes,
  `fitSync.ts`). A push attempt is pre-classified against a live local size check before even
  hitting the network, and a real rejection (`413`/`422` status, or a `401`/`403` matched against
  known size-limit error text) routes the file into persisted `unpushedFiles` tracking rather than
  retrying futilely every sync - see [sync-logic.md](./sync-logic.md), § Explain Sync Status.
- **The whole file is held in memory at once, both directions** - no streaming/chunking anywhere
  in the read or blob-create/fetch path (`FileContent`, `LocalVault`, `RemoteGitHubVault` all
  operate on complete in-memory strings). A 99 MB file (just under the limit) means ~99 MB
  resident in memory during that operation, not a fixed small buffer - the same SHA computation
  above also has to read and hash all of it.
- **Base64 encoding inflates size by ~33%** on the wire and in the blob-creation request body
  (GitHub's blob API accepts base64-encoded content). A 100 MB file becomes a ~133 MB request
  payload - worth knowing when reasoning about whether a file that's *just* over Obsidian's own
  practical size norms will actually hit GitHub's 100 MB ceiling.

**Worked example:** a 150 MB video file dropped into the vault. Local size check flags it before
any network call; push is skipped, the path is added to `unpushedFiles`, and the sync notice
reports it rather than silently dropping it or retrying every sync indefinitely.

## Cross-references

- [sync-logic.md](./sync-logic.md), § Performance Characteristics: the general prose description
  this doc's rows give real numbers for.
