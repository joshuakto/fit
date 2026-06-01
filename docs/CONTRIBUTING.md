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
**Milestone**: [1.5](https://github.com/joshuakto/fit/milestone/2)

Check the milestone for upcoming release priorities and progress.

### Long-Term Strategic Priorities

**🛡️ Core Stability** (always active):
- **Data loss prevention** - Filesystem safety, reliable deletion handling
- **Sync reliability** - Handle edge cases, large files, encoding issues
- **Error diagnostics** - Clear per-file error feedback, actionable messages
- **Performance** - Fast syncs, efficient API usage, mobile optimization

**🚀 Platform Expansion**:
- **Selective `.obsidian/` sync** - Sync plugins/settings without exposing secrets
- **Multi-platform backends** - GitLab, Gitea, self-hosted Git servers
- **Multi-repo sync** - Multiple vaults or vault partitions

**🔒 Security & Privacy**:
- **Encrypted PAT storage** - Platform-native keychains (Keychain, Credential Manager)
- **End-to-end encryption** - Optional encrypted remote storage

**💡 User Experience**:
- **Conflict resolution UX** - Auto-merge, resolution strategies, better workflows
- **Auto-sync triggers** - On save, on open, configurable intervals
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

## Release Process

**Rules that apply to all releases:**
- Version numbers never have a `v` prefix (`1.5.0`, not `v1.5.0`)
- `manifest.json` and `package.json` versions must always match
- Version bumps must be in **dedicated commits**, never mixed with feature or bug-fix changes
- The `main` branch manifest always shows the current **stable** version; beta versions never appear there

### Stable Release

Beta testing is recommended before a stable release. When ready:

1. **Build artifacts**: `npm run build` produces `main.js`

2. **Create the GitHub Release** via the GitHub UI:
   - Tag: `X.Y.Z` — no `v` prefix; mark as a full release (not pre-release)
   - Upload `manifest.json`, `main.js`, `styles.css` as release assets
   - The GitHub Release must exist **before** the version bump PR is merged (automated PR checks enforce this)

3. **Open a PR to `main`** containing only these changes:
   - `manifest.json`: bump `version` to `X.Y.Z`
   - `package.json`: bump `version` to `X.Y.Z`
   - `versions.json`: add `"X.Y.Z": "<minAppVersion>"`
   - Commit message: `Bump version to X.Y.Z`

4. **Merge the PR** — automated checks verify the GitHub Release exists

### Beta Release

Beta releases are for early testing via [BRAT](https://github.com/TfTHacker/obsidian42-brat). They live only on the `beta` branch and are invisible to regular plugin users (never reflected in `main`'s manifest).

1. **Merge `main` into `beta`** (using jj):
   ```shell
   jj new beta main -m "Merge branch 'main' into beta"
   ```

2. **Bump the beta version** directly on the `beta` branch (not via PR to main):
   - `manifest.json`: set `version` to `X.Y.Z-beta.N`, update `minAppVersion` if needed
   - `package.json`: set `version` to `X.Y.Z-beta.N`
   - `versions.json`: add `"X.Y.Z-beta.N": "<minAppVersion>"`
   - Commit message: `Bump version to X.Y.Z-beta.N (minAppVersion: A.B.C)`

3. **Push `beta`** to GitHub

4. **Create a GitHub Pre-release** via the GitHub UI:
   - Tag: `X.Y.Z-beta.N` — no `v` prefix (created here via the GH UI); mark as pre-release
   - Build and upload the same three artifacts as a stable release

BRAT users who point to `joshuakto/fit` receive the latest pre-release automatically.

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

## Code Quality

Please use your judgement and try to follow conventions from surrounding code to keep project quality high. Most critical project guidelines will be validated by GitHub checks on PRs, so there aren't too many strict requirements you need to follow.

**Linting**: Check for code style issues with `npm run lint` and automatically fix fixable issues with `npm run lint:fix`.

If you'd like to help set up more automated checking, there are a few quality aspects we don't have automated checks for but would like to:

- [ ] **ESLint rules** for more known problematic code patterns
- [ ] **Consistent documentation** to ensure comments and architecture docs stay up-to-date with code changes
