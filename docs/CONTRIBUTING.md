# FIT Developer Guide

Developer documentation for the FIT (File gIT) Obsidian plugin.

## Quick Start

```shell
git clone https://github.com/joshuakto/fit.git
cd fit && npm install
npm run dev
```

**Hooks (recommended):** Run lint, typecheck, and tests automatically via git hooks.

1. Install [hk](https://hk.jdx.dev) and [pkl](https://pkl-lang.org/main/current/pkl-cli/index.html#installation) via your package manager:
   - macOS: `brew install hk`
   - Arch Linux: `yay -S hk-bin pkl-bin`
   - Other: see [hk installation docs](https://hk.jdx.dev/installation.html)
2. Register the git hooks: `hk install`

After this, `git push` will run lint, typecheck, and tests, blocking the push on failure and matching what CI checks.

If you use [jj](https://jj-vcs.github.io/jj/), install [jj-hooks](https://crates.io/crates/jj-hooks) to trigger git hooks from jj operations.

**Unit Tests**: Run `npm test` to execute unit tests (Vitest), or `npm run test:watch` for development with file watching.

**E2E Tests**: Run `npm run test:e2e` for desktop tests, `npm run test:android` for Android tests. See `test/README.md` for detailed setup and troubleshooting.

**Manual testing**: Copy `main.js`, `styles.css`, `manifest.json` to `.obsidian/plugins/fit/` in a test vault.

## Documentation

- **[architecture.md](./architecture.md)** - System design, data flow, component relationships
- **[sync-logic.md](./sync-logic.md)** - SHA caching, change detection, conflict resolution, edge cases
- **[api-compatibility.md](./api-compatibility.md)** - Web API safety, cross-platform compatibility, forbidden patterns

## Roadmap & Priorities

### Upcoming Release
**Milestone**: [1.6](https://github.com/joshuakto/fit/milestone/3)

Check the milestone for upcoming release priorities and progress.

### Long-Term Strategic Priorities

_These priorities operationalize the philosophy in [architecture.md § Design Principles](./architecture.md#design-principles) (never lose data, minimize forced user intervention, conservative opt-in, minimize sync churn)._

**🛡️ Core Stability** (always active):
- **Data loss prevention** - Filesystem safety, reliable deletion handling
- **Sync reliability** - Handle edge cases, large files, encoding issues
- **Error diagnostics** - Clear per-file error feedback, actionable messages
- **Performance** - Fast syncs, efficient API usage, mobile optimization

**🚀 Platform Expansion**:
- **Selective `.obsidian/` sync** - v1 shipped in 1.6 (replace-strategy + field tracking); v2: field-level exclusion (#67)
- **Multi-platform backends** - GitLab or Gitea
- **Multi-repo sync** - Multiple vaults or vault partitions

**🔒 Security & Privacy**:
- **Encrypted PAT storage** - Platform-native keychains (Keychain, Credential Manager)
- **End-to-end encryption** - Optional encrypted remote storage

**💡 User Experience**:
- **Conflict resolution UX** - Auto-merge, resolution strategies, better workflows
- **Auto-sync triggers** - On save / on open (shipped, #65); remaining: per-trigger tuning
- **Settings UI improvements** - Visual examples, notification customization

**🔧 Developer Experience**:
- **E2E testing** - Real Obsidian environment tests
- **Performance benchmarking** - Automated regression detection

### Browse Issues by Category

**By priority:**
- [Current milestone](https://github.com/joshuakto/fit/milestone/2) - Active release work
- [Help wanted](https://github.com/joshuakto/fit/labels/help%20wanted) - Community contribution opportunities
- [Good first issue](https://github.com/joshuakto/fit/labels/good%20first%20issue) - Newcomer-friendly tasks

**By type:**
- [Bugs](https://github.com/joshuakto/fit/labels/bug) - Reported issues
- [Enhancements](https://github.com/joshuakto/fit/labels/enhancement) - Feature requests
- [Documentation](https://github.com/joshuakto/fit/labels/documentation) - Docs improvements
- [Needs reproduction](https://github.com/joshuakto/fit/labels/needs-repro) - Awaiting user data

**By platform:**
- [Mobile](https://github.com/joshuakto/fit/labels/mobile) - Mobile-specific issues

## Getting Help

- **Questions**: [GitHub Discussions](https://github.com/joshuakto/fit/discussions)
- **Bugs**: [GitHub Issues](https://github.com/joshuakto/fit/issues)
- **Test failures**: See `test/README.md` for E2E test troubleshooting tips

## Contributing

### Pull Request Process

1. **Create feature/bug branch** from `main`
2. **Make your changes** following existing code patterns
3. **Create PR** with clear description

All PRs are automatically checked by GitHub Actions for:
- ✅ Code linting and formatting
- ✅ TypeScript compilation
- ✅ Unit test execution
- ✅ E2E test execution (desktop)
- ✅ E2E test execution (Android)
- 📊 Test coverage reporting (informational)
- 🔍 Security scanning via CodeQL

Please try to avoid breaking functionality (on desktop or mobile), and test major changes to ensure they work correctly.

### Security Requirements

- **Validate user inputs**
- **Don't log Personal Access Tokens (PATs)**
- **Don't upload sensitive files** such as plugin settings files that may contain secrets without explicit user authorization

### Key Guidelines

- **Follow existing patterns** in the codebase
- **Handle errors gracefully** especially for GitHub API calls
- **Preserve user data** during sync conflicts
- **Test edge cases** (large files, network issues, invalid credentials)
- **Mobile compatibility is normative, not optional** — no Node.js built-ins, no `Buffer`, no non-fatal `TextDecoder`. See [api-compatibility.md](./api-compatibility.md) for the full list; violations cause silent failures or crashes on mobile

## Release Process

**Rules that apply to all releases:**
- Version numbers never have a `v` prefix (`1.5.0`, not `v1.5.0`)
- `manifest.json` and `package.json` versions must always match
- Version bumps must be in **dedicated commits**, never mixed with feature or bug-fix changes
- The `main` branch manifest always shows the current **stable** version; pre-release versions never appear there

### Using the release script (maintainers)

`scripts/release.sh` automates the full release flow for all channels:

```shell
./scripts/release.sh alpha    # e.g. 1.5.0 → 1.6.0-alpha.1
./scripts/release.sh beta     # e.g. 1.6.0-alpha.3 → 1.6.0-beta.1
./scripts/release.sh stable   # e.g. 1.6.0-beta.2 → 1.6.0

./scripts/release.sh alpha 1.6.0-alpha.5   # explicit version override
```

The script runs pre-flight checks, bumps version files, commits and tags, pushes, and creates a draft GitHub release. The CI workflow `release-assets.yml` then builds and attaches `main.js`, `styles.css`, and `manifest.json` automatically.

After the script completes:
1. **Stable only:** apply the pending README changes listed in [Pending README changes for next stable release](#pending-readme-changes-for-next-stable-release) below, then commit
2. Review and curate the auto-generated release notes on GitHub (comms step)
3. Publish the draft release
4. For stable: ask the head maintainer to post in [Announcements](https://github.com/joshuakto/fit/discussions/categories/announcements)
5. For alpha/beta: post in [Beta Testing](https://github.com/joshuakto/fit/discussions/categories/beta-testing)

### Version scheme

Pre-releases use `MAJOR.MINOR.PATCH-CHANNEL.N` (e.g. `1.6.0-alpha.1`, `1.6.0-beta.2`). The channel label (`alpha`/`beta`) appears in the version string but BRAT does not distinguish between them — both are delivered to anyone who enabled pre-release updates. Use `alpha` for incomplete milestone work and `beta` for feature-complete pre-releases approaching stable.

### How pre-releases reach BRAT users

BRAT detects pre-releases by the `prerelease` flag on GitHub Releases (not by the version string). Pre-release version bumps are **not pushed to `main`** — the version bump commit lives only in the release tag's ancestry, so `main`'s manifest always reflects the last stable version.

### Anti-Patterns

| ❌ Anti-pattern | Why it's a problem |
|---|---|
| Bumping version in a feature/bug PR | Blocks doc reviews and makes rollback harder; automated checks will reject it |
| `v` prefix on version tag (e.g. `v1.4.0`) | Breaks the Obsidian plugin registry and BRAT version detection |
| Bumping `manifest.json` on `main` before the GH Release exists | Plugin installed from `main` references a non-existent release ([#59](https://github.com/joshuakto/fit/issues/59)); automated checks will reject it |
| Beta version in `main`'s `manifest.json` | Exposes pre-release to all users; automated checks will reject it |
| `manifest.json` and `package.json` versions out of sync | Confuses tooling and reviewers; automated checks will reject it |

See [Obsidian Hub release guide](https://publish.obsidian.md/hub/04+-+Guides%2C+Workflows%2C+%26+Courses/Guides/How+to+release+a+new+version+of+your+plugin) for general Obsidian plugin release context.

---

## Pending README changes for next stable release

`README.md` is shipped as-is in the Obsidian community plugin directory, so it must always describe the current **stable** release — not unreleased changes sitting in `main` or beta. Upcoming features may be hinted at, but only clearly labeled as upcoming, never presented as already generally available.

Apply these manually when cutting stable, then clear the list. Add to this list as you ship features that change what README says.

- **Remove "still in beta" note** (line ~20): delete the `**Note:** This plugin is still in beta...` line.
- **Remove "Coming soon" section**: the "Explain Sync Status" command shipped in 1.6 — delete the entire `## Coming soon` block (the heading, description, and preview image).
- **Update `.obsidian/` bullet** (under "NOT synced"): remove the `(selective opt-in coming in 1.6)` qualifier — it shipped.
- **Convert "Coming in the 1.6 release" callout** to present tense: the hidden-files, selective `.obsidian/` sync, and canvas auto-merge features are all live. Rewrite as "New in 1.6:" rather than "Coming in the 1.6 release:". Also move the canvas auto-merge bullet into the conflict handling section as a permanent feature description (remove the "coming in" framing).
- **Retake the settings screenshot** (line ~39): the current screenshot predates 1.5 UI changes. Capture a fresh screenshot of the FIT settings panel and replace the image at that line.
- **Update GitHub Enterprise Server note** (Setup section): once GHE support ships in stable, reword "The plugin defaults to github.com. GitHub Enterprise Server support is coming soon." to state it's supported (e.g. "The plugin defaults to github.com, but also supports GitHub Enterprise Server hosts.").

---

## Code Quality

Please use your judgement and try to follow conventions from surrounding code to keep project quality high. Most critical project guidelines will be validated by GitHub checks on PRs, so there aren't too many strict requirements you need to follow.

**Linting**: Check for code style issues with `npm run lint` and automatically fix fixable issues with `npm run lint:fix`.

**Testing**: stack is Vitest + `src/__mocks__/obsidian.ts` (aliased as `'obsidian'` in `vitest.config.ts`). These guidelines are also declared, in condensed form, as a review rule in [`rules/testing-standards.md`](../rules/testing-standards.md); keep the two in step.

- **One test = one thing.** Use parameterized tests for variations, not near-duplicate tests that hit the same line with a different magic number. If a *shipped default* also matters, assert it flows through unmodified (no override passed) rather than duplicating the same check with a second hardcoded constant.
- **Mock only true external boundaries** (Obsidian's API), not our own internal modules (`src/*.ts`). Mocking an internal collaborator only proves args were forwarded to it — it hides real bugs inside that collaborator instead of catching them.

  Bad — mocking `src/utils.ts`'s `showFileChanges` when testing `fitPlugin.ts`'s call site hides real bugs in `showFileChanges` itself and only proves args were forwarded:
  ```ts
  vi.mock('@/utils', () => ({ showFileChanges: vi.fn(), showUnappliedConflicts: vi.fn() }));
  // ...
  expect(showFileChanges).toHaveBeenCalledWith(changeGroups, expect.any(Map), 30000);
  ```
  Good — mock the real external boundary (`obsidian`'s `Notice`) and let `showFileChanges` run for real, so its own logic stays covered:
  ```ts
  const { NoticeCtor } = vi.hoisted(() => ({ NoticeCtor: vi.fn() }));
  vi.mock('obsidian', async (importOriginal) => {
  	const actual = await importOriginal<typeof import('obsidian')>();
  	class SpyNotice extends actual.Notice {
  		constructor(message: string, duration?: number) {
  			super(message, duration);
  			NoticeCtor(message, duration);
  		}
  	}
  	return { ...actual, Notice: SpyNotice };
  });
  // ...
  expect(NoticeCtor).toHaveBeenCalledWith('', 30000);
  ```
  See `src/fitPlugin.test.ts` describe block `'FitPlugin sync-success notice duration wiring'`.

- **Prefer fakes over mocks/spies for the vault boundary.** `FakeLocalVault`/`FakeRemoteVault` (`src/testUtils.ts`) are real, working implementations of the same `IVault` interface the production vaults implement. Driving a test through them and asserting on the resulting state (`getAllFilesAsRaw()`, `localStoreState`) exercises the real sync decision logic end-to-end. Spying on a fake's own method only proves a call happened, not that the resulting state is correct, and breaks on refactors that preserve behavior but change call shape — reserve spies for proving something was *not* called.
- **Test observable behavior, not internal bookkeeping.** Prefer asserting on what a caller actually observes — file content, the returned result, or a *later* sync's behavior — over an internal cache field. This matters especially for failure-injection tests: a fake vault's failure simulation already blocks the write, so "content unchanged right after the simulated failure" can pass identically whether or not the fix actually works. The assertion that distinguishes correct from buggy behavior is usually whether a *later* sync (after the failure is lifted) successfully retries.
- **Assert the whole result object, not one indexed field.** E.g. assert all of `getAllFilesAsRaw()`, not `getAllFilesAsRaw()['one/path']` — indexing into a single path proves that path is right but says nothing about whether an unrelated file was wrongly touched. Comment *why* each entry is present (or notably absent) inline, on its own line. This doesn't require a literal exact-value match — placeholder matchers (`expect.any(...)`, `expect.objectContaining(...)`, etc.) inside the whole-object assertion are fine; the point is covering every entry, not hardcoding every value.

  ```ts
  // Bad — only proves one path is right, says nothing about the other three:
  expect(localVault.getAllFilesAsRaw()['normal.md']).toBe('Normal file content');

  // Good — whole object, every entry's provenance documented on its own line. Absence is a
  // claim too — say it the same way, on its own comment-only line, where the key would sort:
  expect(localVault.getAllFilesAsRaw()).toEqual({
  	'_fit/conflict.md': 'Remote version saved locally', // Local-only (created in step 1)
  	'_fit/nested/file.md': 'Another conflict',          // Local-only (created in step 1)
  	'normal.md': 'Normal file content',                 // Synced (created in step 1)
  	// '_fit/remote-conflict.md' absent — remote pushed it in step 3, silently ignored (no _fit/_fit/ write)
  	'remote-normal.md': 'Normal remote file'            // Pulled from remote (step 4)
  });
  ```
  See `fitSync.realFit.test.ts` (`_fit/` conflict-preservation test).

- **Assert one complete value, not its pieces.** Prefer `toEqual(expect.objectContaining(...))` over several separate `expect(x.a)` / `expect(x.b)` calls on the same result, and over `toMatchObject` when a sibling field carries diagnostic info (e.g. `SyncResult`'s `success`/`error`) — splitting a logical check loses the full context (e.g. an unexpected `error` field) that would otherwise show up on failure.

  ```ts
  // Bad — two calls, and a failure on the first never shows what error actually happened:
  expect(result.success).toBe(true);
  expect(result.changeGroups).toContainEqual({ path: 'x', type: 'MODIFIED' });

  // Good — one assertion, failure output includes the whole result (error included if it failed):
  expect(result).toEqual(expect.objectContaining({
  	success: true,
  	changeGroups: expect.arrayContaining([{ path: 'x', type: 'MODIFIED' }]),
  }));
  ```

- **Scope-document each test file.** A short header comment stating what the file covers, and how it differs from siblings, saves readers from having to diff two similarly-named test files to find out.

If you'd like to help set up more automated checking, there are a few quality aspects we don't have automated checks for but would like to:

- [ ] **ESLint rules** for more known problematic code patterns
- [ ] **Consistent documentation** to ensure comments and architecture docs stay up-to-date with code changes
