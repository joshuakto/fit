# Sync scenario matrix

Decision table mapping sync/merge correctness scenarios exhaustively across a small set of
dimensions, instead of reasoning about cases one at a time. A test suite alone can't answer
"what's *not* tested" - cross-cutting dimension combinations are easy to silently undercover even
when every individual axis has its own passing tests, which is how rule-disagreement bugs
(see the exceptional-path table's cross-device rule disagreement and self-clash rows) stay hidden. See
[sync-logic.md](./sync-logic.md) for the authoritative description of current behavior and
mechanism; this doc is the *test-planning* artifact, not a second copy of that reference. In
particular, sync-logic.md's § Sync Operation Types documents the per-file mechanism each row
below exercises, and its § Version Migration Safety / § Network Interruption cover two of the
compatibility factors below in more depth. For cost rather than correctness, see
[Sync Performance Inventory](./sync-performance-inventory.md) - a scenario can be ✅ here and
still be an unbounded-cost hot path there, which is why they're separate docs.

## Method

- **Dimensions first, values second.** Listing dimensions before rows surfaces hidden coupling
  early (e.g. path category and resolved-rule agreement only interact for `.obsidian/` paths -
  ordinary vault paths don't have a rule to disagree about).
- **"Don't-care" applies to inputs, never to outcomes.** A dimension combination can be
  irrelevant or inapplicable (e.g. rule agreement doesn't apply to ordinary vault paths - there's
  no rule to disagree about), and a whole category can be out of scope entirely (see Categories
  not modeled below). Once a row exists, though, its outcome is never "don't care" - every row
  resolves to a real test, a confirmed bug, or a reserved-for-unshipped-feature marker (below),
  stated in prose, never left implicit.
- **Pairwise (2-way) coverage is the default bar**, not full combinatorial explosion. Exhaustive
  (3-way+) treatment only where the failure mode is severe enough to warrant it.

## Dimensions

Each dimension's values are self-labeling on purpose - no bare "yes"/"no" cells anywhere below,
since a bare yes/no forces re-checking the column header to know what it means. If a cell needs
the header to be readable, the label is wrong.

| Dimension | Values | Notes |
|---|---|---|
| Resolved-rule agreement | 🟢 rules agree / 🟡 rules differ (fitattributes lag) | Whether local's resolution of its own bytes and remote's resolution of its own bytes actually diverge - not a raw config-value diff (configs can differ with identical resulting logical content, which isn't a clash). Version-driven rule drift is a related but distinct concern - see Known compatibility factors below. |
| Tracking state | 🆕 untracked, never observed / 👻 untracked, observed while ineligible / 👀 tracked | Onboarding state. Distinguishes true first-contact from the "was excluded, now eligible" reconcile case. |
| Local edit | ✏️ local edited / ⚪ local unchanged / 🗑️ local deleted / n/a | |
| Remote edit | ✏️ remote edited / ⚪ remote unchanged / 🗑️ remote deleted / n/a | |
| Pre-existing clash | 🔀 clash pending / ⚪ no clash | Must never be silently overridden by an unrelated reconcile/observe pass. |
| Mid-sync failure | ⚪ no failure / 💥 local write fails / 💥 remote push skipped or rate-limited / 💥 fetch fails | Baseline must not advance past a confirmed operation - a documented invariant, easy to violate case-by-case. |
| Path category | ordinary vault path / hidden vault path (non-`.obsidian/`) / `.obsidian/` (`format:"text"`) / `.obsidian/` (`format:"json"`) / `.fitattributes.json` itself / `_fit/` itself / symlink (on disk, or a remote `mode 120000` entry) | `_fit/` is FIT's own scratchpad - unconditionally excluded both directions (`shouldSyncPath`), regardless of every other dimension, including on remote if another device or a manual git push puts real content there. Reflects the *resolved* category only - whether a path landed there via an explicit `.fitattributes.json` rule or a heuristic default doesn't change behavior, so it doesn't get a separate value here. `.canvas` is called out explicitly where it appears because it's the one path shape with a dedicated merge spec (id-keyed `nodes`/`edges` set-union, `mergeSpecForPath` in `jsonMerge.ts`) - it goes through the exact same `format:"json"` dispatch as any other JSON path, it just doesn't share the generic key-level spec everything else gets. `.fitattributes.json`'s own sync is a special case of every other dimension (self-clash on its own copy) rather than exempt from them. This is a real table column below, not just a Dimensions-table entry - a row should be identifiable from its input cells alone, without reading Status. |

### Categories not modeled here

High-level scenario categories deliberately outside this doc's scope entirely: whole axes this
matrix doesn't attempt to enumerate, not rows with a status. An item graduates out of this list
once it's actually modeled as a dimension or its own table; plugin-version upgrade/downgrade did
exactly that, into the Known compatibility factors table below.

- **Intricate JSON-merge design questions**, e.g. treating an arbitrary array field as an
  unordered set beyond `.canvas`'s hardcoded id-keyed mechanism, or targeting a field several
  levels deep once field-level masking exists. Real, undesigned, but a design-space question,
  not a scenario dimension.
- **Encryption-at-rest interactions.** `sync-logic.md` notes the SHA-parity fast path is skipped
  when encryption is enabled; this doc doesn't attempt to enumerate encrypted-vault scenarios
  separately.

## Tables of scenarios

Each row is one scenario family. ✅ links a real test proving correct behavior; 🔴 marks
*confirmed wrong* behavior (a real bug, with a test proving it - see Canvas delete-vs-edit below);
🚧 marks a row that can't be exercised yet because the feature it depends on isn't built (not a
bug claim either way). There is deliberately no separate "untested, don't know" marker - per the
Method section above, every row must resolve to one of these three, not sit in an unverified
middle state.

### Normal path (rules agree, no pending clash, no mid-sync failure)

| Path category | Tracking state | Local edit | Remote edit | Status |
|---|---|---|---|---|
| ordinary vault path | 👀 tracked | ⚪ unchanged | ✏️ edited | ✅ ordinary pull path, exercised throughout `fitSync.realFit.test.ts` (e.g. `'should write remote hidden files directly when no local version exists'`) |
| ordinary vault path | 👀 tracked | ✏️ edited | ⚪ unchanged | ✅ ordinary push path (same file, symmetric case) |
| ordinary vault path | 👀 tracked | ✏️ edited | 🗑️ deleted | ✅ `'given a tracked file edited locally and deleted remotely, should push the local edit back instead of leaving the paths diverged'` - the edit wins and is pushed (see [sync-logic.md § Conflict Types](./sync-logic.md)) |
| ordinary vault path | 👀 tracked | ✏️ edited | ✏️ edited | ✅ `'should report file as conflict when saved to _fit/ for any safety reason'` |
| hidden vault path (non-`.obsidian/`) | 🆕 untracked, never observed | n/a | ✏️ edited | ✅ `'should write remote hidden files directly when no local version exists (#...'` |
| hidden vault path (non-`.obsidian/`) | 👀 tracked | ⚪ unchanged | ⚪ unchanged | ✅ **Baseline path (or its folder) pruned from this sync's scan.** Not pushed as a deletion; see [sync-logic.md § Scan-time pruning vs. the stored baseline](./sync-logic.md#scan-time-pruning-vs-the-stored-baseline). `'does not push a deletion for a baseline path this sync pruned'`. The scan also skips a path it fails to list (logged), reported the same way: `'reports a path whose listing fails as an orphaned scan prefix'` |
| hidden vault path (non-`.obsidian/`) | 👀 tracked | ⚪ unchanged | ✏️ edited | ✅ **Same, remote side edited.** Ignored this sync: no clash, no pull. `'does not pull a remote edit over a path this sync could not see'` |
| hidden vault path (non-`.obsidian/`) | 👀 tracked | ⚪ unchanged | 🗑️ deleted | ✅ **Same, remote side deleted.** Local copy kept. `'does not apply a remote deletion to a path this sync could not see'` |
| `.obsidian/` (`format:"text"`) | 👻 untracked, observed while ineligible | ⚪ unchanged, matches remote already | n/a | ✅ `'re-establishes a baseline quietly (no push) for a re-eligible path...'` |
| `.obsidian/` (`format:"text"`) | 👻 untracked, observed while ineligible | 🗑️ deleted while ineligible | n/a | ✅ `'pulls fresh content for a re-eligible path whose local file was deleted...'` |
| ordinary vault path (`.canvas`) | 👀 tracked | ✏️ edited | ✏️ edited, different node than local | ✅ `'independent node additions on both sides auto-merge without a clash file'` and sibling merge tests |
| ordinary vault path (`.canvas`) | 👀 tracked | ✏️ edited | ✏️ edited, same node as local | ✅ `'same-node conflict (both sides edit same id): falls back to _fit/ clash file'` |
| ordinary vault path (`.canvas`) | 👀 tracked | ✏️ edited | 🗑️ deleted (same node local edited) | 🔴 **Gap.** `mergeKeyedArrays` never consults base for a node id missing from one side - intended behavior is a real conflict (one side deleted, the other edited the same node), but it currently silently keeps local's edit as if remote had never touched it. `jsonMerge.test.ts`'s `'remote deletion against a local edit of same item doesn't yet conflict (TODO)'` asserts today's actual (wrong) output directly, so it'll start failing the day this is fixed - that's the signal to update it, not a passing bar to preserve. |
| `.obsidian/` (`format:"json"`, field-level masked, `scope:"subset"`) | 👀 tracked | ✏️ edited (masked) | ✏️ edited (masked) | ✅ `'surfaces a subset-scope clash in the sync result clash array, not just pendingClashes'` |
| `.obsidian/` (`format:"json"`, field-level masked, `scope:"subset"`) | 👀 tracked | 🗑️ deleted (while still under `scope:"subset"`) | ⚪ unchanged | ✅ **Fixed.** Deletion now propagates instead of self-healing via re-pull. `'deleting a tracked scope:"subset" path locally propagates the deletion to remote instead of self-healing via re-pull'`. Mechanism: [sync-logic.md § `.fitattributes.json`](./sync-logic.md), Architecture note. |
| `.obsidian/` (`format:"json"`, field-level masked, `scope:"subset"`) | 👀 tracked | 🗑️ deleted | ✏️ edited (tracked field) | ✅ Clashes instead of silently destroying remote's concurrent edit. `'deleting a tracked scope:"subset" path locally while remote concurrently edits the tracked field clashes instead of silently deleting remote's edit'`. |
| `.obsidian/` (`format:"text"`) | 👀 tracked | 🗑️ deleted | ⚪ unchanged | ✅ Comparison case for the two rows above — same mechanism, predates `scope:"subset"` field-level masking. `'deleting a tracked format:"text" .obsidian/ path locally pushes the deletion to remote'`. |
| `.obsidian/` (`format:"text"`) | 🆕 untracked, never observed | n/a (local absent) | ✏️ edited (first content) | ✅ **Fresh-install / no-baseline default.** No prior `localShas`/`lastFetchedRemoteShas` entry for this path (true first contact, e.g. right after a plugin upgrade with no tracking history at all) - local-absent-remote-present reads as ADDED, not a deletion signal, same convention `resolveSubsetScopePath`'s own first-sync check (`priorRemoteSha === undefined && priorRawSha === undefined`) already uses. Two-sync shape (`isTracked` gate, see [sync-logic.md § Protected Paths](./sync-logic.md)): `'syncs a previously-observed .obsidian/ file directly (not to _fit/) once tracked and format-eligible'`. |
| `.obsidian/` (`format:"text"`) | 👀 tracked | n/a | 🗑️ deleted | ✅ `'leaves an unedited .obsidian/ file on disk when remote removes it, instead of...'` (untrack, not delete) |
| `.obsidian/` (`format:"text"`) | 👀 tracked | ✏️ edited | 🗑️ deleted | ✅ `'treats a locally-edited .obsidian/ path as an ordinary clash (not an untrack...'` - reported once, not recorded (known limitation, see the test) |
| `_fit/` itself | 👀 tracked | ✏️ edited | ⚪ unchanged | ✅ `'should exclude 📁 _fit/ directory from sync operations'` - never pushed, regardless of content |
| `_fit/` itself | 👀 tracked | ⚪ unchanged | ✏️ edited (a real `_fit/` path exists on remote - another device, or a manual git push) | ✅ same test - SHA cached in `lastFetchedRemoteShas` (to detect future changes) but never written locally, no `_fit/_fit/` nesting. Internal wrinkle, not a correctness gap: `fitSync.ts` has a TODO noting this relies on a post-hoc `filterSyncedState` scrub rather than upfront filtering earlier in the pipeline - safe today, just not the cleanest shape. |
| symlink, non-hidden (on disk only) | 🆕 untracked | ⚪ link present | n/a | ✅ `'adds an unindexed hidden path, but not an unindexed non-hidden one (which looks like a symlink)'` - ignored and logged, never flattened into copies of its target |
| symlink under a hidden path (on disk only) | 🆕 untracked | ⚪ link present | n/a | 🔴 **Gap.** `adapter.list` follows the link, so the scan admits flattened copies of the target (a cycle recurses until the OS link-depth limit). Bounded by the walk caps in `'hidden-path scan walk bounds (#389)'`, not prevented |
| symlink, dangling, inside a hidden folder | 🆕 untracked | ⚪ link present | n/a | 🔴 **Gap.** The adapter rejects the whole listing, so the folder is skipped and surfaced as unlistable. Safe (`'logs a path whose listing fails instead of silently dropping it'`), but its other hidden files do not sync that sync |
| symlink on disk, regular file at the same path on remote | 🆕 untracked | ⚪ link present | ✏️ remote added/edited | ✅ `'does not pull a remote edit over a path this sync could not see'` - the ignored link's path has unknown scan coverage, so the remote change is dropped rather than written through the link (test covers an unscannable path in general, not a link specifically) |
| symlink on remote (`mode 120000`), nothing local | 🆕 untracked | n/a | ✏️ remote added | 🔴 **Gap.** The remote read keeps only `path → sha`, so the entry looks like an ordinary file and is pulled as a regular file holding the target text. The read half is pinned by `'given a tree with a symlink entry (mode 120000), should not report it as an ordinary file (BUG: ...'` |
| symlink on remote (`mode 120000`), pulled earlier as a regular file | 👀 tracked | ✏️ edited | ⚪ unchanged | 🔴 **Gap.** The push writes the blob as `100644`, converting the remote symlink into a regular file. Pinned by `'given a symlink entry (mode 120000) and content pushed to its path, should not convert it to a regular file (BUG: ...'` |

Invariants: rule agreement is 🟢 agree, pre-existing clash is ⚪ no clash, and mid-sync failure is
⚪ no failure, every row - all three columns dropped.

### Exceptional path (rule disagreement, pending clash, and/or mid-sync failure)

| Path category | Rule agreement | Tracking state | Local edit | Remote edit | Pre-existing clash | Mid-sync failure | Status |
|---|---|---|---|---|---|---|---|
| `.obsidian/` (`format:"text"`) | 🟢 agree | 👻 untracked, observed while ineligible | n/a | n/a | 🔀 clash pending | ⚪ no failure | ✅ `'does not disturb an unresolved .obsidian/ clash even when the path also qualifies as a reconcile candidate'` (the exact guard this table's method would have demanded before shipping) |
| `.obsidian/` (`format:"json"`, field-level masked, `scope:"subset"`) | 🟡 differ (lag) | 👀 tracked | ⚪ unchanged | ✏️ edited (masked/partial under remote's rule) | ⚪ no clash | ⚪ no failure | ✅ **Rule-disagreement overwrite, fixed content-based (not rule-based).** `needsMaskedOverlayForPull` asks whether an opaque pull would drop a top-level key local's file has that remote's blob doesn't, independent of any `.fitattributes.json` metadata on either side — so it covers both triggers below with one mechanism. Cross-device: `'cross-device rule disagreement: an opaque format:"text" pull that would drop an untracked local field is caught and overlaid instead, even with no remote .fitattributes.json at all'`. Single-device (both sides currently agree on the rule, but remote's blob predates that agreement, still shaped by this path's *previous* rule): `'single-device rule evolution: switching a path from scope:"subset" to format:"text" does not lose an untracked field on the next pull'`. See [sync-logic.md § `.fitattributes.json`](./sync-logic.md), "Cross-device rule disagreement". |
| `.fitattributes.json` itself | 🟡 differ (lag), self-referential | n/a | ✏️/⚪ either | ✏️/⚪ either | 🔀 clash mid-flight | ⚪ no failure | ✅ **Self-clash, same fix as the row above.** Local's live config always governs local's own decisions, remote's committed blob is fetched independently, and neither ever consults `_fit/.fitattributes.json`'s clash copy — so `.fitattributes.json` being mid-clash on itself can't corrupt routing for any other path. `'a pending self-clash on .fitattributes.json does not corrupt routing for another masked path clashing in the same sync'` exercises both at once: `.fitattributes.json` clashes as an ordinary whole file while a masked path's field clash in the same sync resolves normally. See [sync-logic.md § `.fitattributes.json`](./sync-logic.md), "Self-clash". |
| ordinary vault path | 🟢 agree | 👀 tracked | ✏️ edited | ⚪ unchanged | ⚪ no clash | 💥 local write fails | ✅ `'should retry a failed local delete next sync instead of losing track of...'` |
| ordinary vault path | 🟢 agree | 👀 tracked | ⚪ unchanged | ✏️ edited | ⚪ no clash | 💥 remote push skipped/rate-limited (unrelated file) | ✅ `'rate-limited file: localShas cleared so it is re-detected on next sync'` and siblings |
| ordinary vault path | 🟢 agree | 👀 tracked | ✏️ edited | ⚪ unchanged | 🔀 clash pending | ⚪ no failure, sync repeated | ✅ clash lifecycle series `'A:'`...`'H:'` |
| ordinary vault path | 🟢 agree | 👀 tracked | 🗑️ deleted | ✏️ edited | 🔀 clash pending | ⚪ no failure, sync repeated | ✅ **Fixed (#283).** Doesn't fold into the row above — a delete/modify clash's own creation state (local absent, `_fit/` present) was indistinguishable from "user deleted local to resolve," so the very next sync silently pushed the deletion and cleaned up the `_fit/` copy with zero user action. `'I: delete/modify clash left untouched — next sync must NOT push the deletion or clear the pending clash (#283)'`. |
| n/a (whole-sync failure, not path-specific) | 🟢 agree | 👀 tracked | n/a | n/a | n/a | 💥 fetch fails entirely this sync | ✅ `'a whole-sync remote fetch failure leaves localShas/lastFetchedRemoteShas/protectedPathShas untouched'` - already a guaranteed no-op by `_doSync`'s error-path rollback (`fitSync.ts`), this test just confirms it; see [sync-logic.md § Network Interruption](./sync-logic.md), the "before commit created" case |

Invariant: every row has at least one of rule disagreement, pending clash, or mid-sync failure -
that's what puts it here instead of the normal-path table.

### Known compatibility factors

Cases where the *stored baseline's own format* changes across plugin versions, independent of any
`.fitattributes.json` rule - doesn't fit the per-sync dimensions above, so it gets its own table.
Includes the plugin-version-upgrade/downgrade concern: a device on an old build and a
remote-observed path resolved under a newer build's defaults is the same shape of problem as a
rule-agreement mismatch (two sides resolve a path differently), just driven by code version
instead of config lag.

| Factor | Status |
|---|---|
| Legacy `localSha` SHA-1 algorithm superseded by canonical `localShas` (`LocalVault.fileLegacySha1` vs `fileSha1`) | ✅ extensively covered - `'localShas only (clean v2) — no migration, localSha empty'`, `'localSha only (legacy data) — localShas empty, localSha populated'`, `'both present (downgrade scenario) — both populated'`, `'unchanged file with legacy SHA — promoted silently, not in changes'`, `'changed file with legacy SHA — detected as ADDED, entry cleared'`, `'downgrade scenario (both fields) — re-promoted on match'`, `'orphaned legacy entry for deleted file — cleaned up'` |
| Tracking capability removed (setting toggle or version change stops seeing a previously-tracked file) | ✅ `'must NOT delete remote files when tracking capabilities removed (version migration safety)'`; see [sync-logic.md § Version Migration Safety](./sync-logic.md) |
| `obsidianSyncRules` (pre-1.6.0 alpha settings toggle) one-time migration to `.fitattributes.json` | ✅ `fitPlugin.test.ts`'s `'FitPlugin.loadSettings — obsidianSyncRules migration'` block (4 tests: writes a `format:"text"` entry per legacy path + Notice, doesn't overwrite an existing entry, merges into an existing file, no-op when nothing to migrate). See [sync-logic.md § Migrating from obsidianSyncRules](./sync-logic.md). |
| Heuristic format-default stability (`HEURISTIC_TEXT_EXTENSIONS` in `fitAttributes.ts`, and any future heuristic list alongside it, never shrink or change meaning across versions, so an already-tracked path's resolved rule can't flip on its own) | ✅ `fitSync.realFit.test.ts`'s `it.each(['.css', '.md', '.txt', '.CSS', '.Md'])('syncs a tracked %s path as format:"text" with no .fitattributes.json entry', ...)` exercises the real heuristic default (case-insensitive) through the actual sync pipeline - not just the parsing helper in isolation. Doesn't pin the list as append-only going forward, but "does today's default still work end-to-end" is the more meaningful claim anyway. |

## Test minimap

Partial listing of test names relevant to the scenario matrix:

```
fitSync.realFit.test.ts
└ FitSync
  ├ Protected path handling (📁 shouldSyncPath filtering)
  │ ├ 'should exclude 📁 _fit/ directory from sync operations'
  │ ├ 'syncs a tracked %s path as format:"text" with no .fitattributes.json entry' (.each)
  │ ├ 'leaves an unedited .obsidian/ file on disk when remote removes it, instead of...'
  │ ├ 'treats a locally-edited .obsidian/ path as an ordinary clash (not an untrack...'
  │ ├ 're-establishes a baseline quietly (no push) for a re-eligible path...'
  │ ├ 'pulls fresh content for a re-eligible path whose local file was deleted...'
  │ └ 'does not disturb an unresolved .obsidian/ clash even when the path also qualifies as a reconcile candidate'
  ├ 👻 Hidden file handling
  │ └ 'should write remote hidden files directly when no local version exists (#...'
  ├ Hidden-path scan pruning — baseline safety (#389)
  │ ├ 'does not push a deletion for a baseline path this sync pruned'
  │ ├ 'does not pull a remote edit over a path this sync could not see'
  │ └ 'does not apply a remote deletion to a path this sync could not see'
  ├ 🚨 Data loss prevention (safety nets for bugs/migrations)
  │ ├ 'should report file as conflict when saved to _fit/ for any safety reason'
  │ ├ 'given a tracked file edited locally and deleted remotely, should push the local edit back instead of leaving the paths diverged'
  │ ├ clash lifecycle: pending resolution across multiple syncs
  │ │ └ 'A:' ... 'I:' series (remote-changes-during-clash, user-resolves variants, reload-survival, delete/modify #283)
  │ └ 'must NOT delete remote files when tracking capabilities removed (version migration safety)'
  ├ Per-File Error Handling
  │ └ 'should retry a failed local delete next sync instead of losing track of...'
  ├ rateLimitedPaths — transient upload failure retry
  │ └ 'rate-limited file: localShas cleared so it is re-detected on next sync'
  ├ Canvas auto-merge (#309)
  │ ├ 'independent node additions on both sides auto-merge without a clash file'
  │ └ 'same-node conflict (both sides edit same id): falls back to _fit/ clash file'
  ├ scope: "subset" field-level masking
  │ ├ 'surfaces a subset-scope clash in the sync result clash array, not just pendingClashes'
  │ ├ 'cross-device rule disagreement: an opaque format:"text" pull that would drop an untracked local field is caught and overlaid instead...'
  │ ├ 'single-device rule evolution: switching a path from scope:"subset" to format:"text" does not lose an untracked field on the next pull'
  │ ├ 'deleting a tracked scope:"subset" path locally propagates the deletion to remote instead of self-healing via re-pull'
  │ ├ 'deleting a tracked scope:"subset" path locally while remote concurrently edits the tracked field clashes instead of silently deleting remote's edit'
  │ ├ 'deleting a tracked format:"text" .obsidian/ path locally pushes the deletion to remote'
  │ ├ 'first sync ever with pre-existing conflicting content on both sides clashes without a spurious merge attempt changing the outcome'
  │ └ 'a pending self-clash on .fitattributes.json does not corrupt routing for another masked path clashing in the same sync'
  ├ Whole-sync fetch failure
  │ └ 'a whole-sync remote fetch failure leaves localShas/lastFetchedRemoteShas/protectedPathShas untouched'
  └ SHA migration (localSha → localShas)
    ├ loadLocalStore field mapping
    │ ├ 'localShas only (clean v2) — no migration, localSha empty'
    │ ├ 'localSha only (legacy data) — localShas empty, localSha populated'
    │ └ 'both present (downgrade scenario) — both populated'
    └ getLocalChanges: per-file migration
      ├ 'unchanged file with legacy SHA — promoted silently, not in changes'
      ├ 'changed file with legacy SHA — detected as ADDED, entry cleared'
      ├ 'downgrade scenario (both fields) — re-promoted on match'
      └ 'orphaned legacy entry for deleted file — cleaned up'

localVault.test.ts
└ LocalVault › hidden-path scan walk bounds
  ├ 'adds an unindexed hidden path, but not an unindexed non-hidden one (which looks like a symlink)'
  ├ 'logs a path whose listing fails instead of silently dropping it'
  └ 'reports a path whose listing fails as an orphaned scan prefix'

remoteGitHubVault.test.ts
├ 'given a tree with a symlink entry (mode 120000), should not report it as an ordinary file (BUG: ...'
└ 'given a symlink entry (mode 120000) and content pushed to its path, should not convert it to a regular file (BUG: ...'
```

