# FIT Developer Guide

Developer documentation for the FIT (File gIT) Obsidian plugin.

## Quick Start

```shell
git clone https://github.com/joshuakto/fit.git
cd fit && npm install
npm run dev
```

**Unit Tests**: Run `npm test` to execute unit tests (Vitest), or `npm run test:watch` for development with file watching.

**Manual testing**: Copy `main.js`, `styles.css`, `manifest.json` to `.obsidian/plugins/fit/` in a test vault.

## Documentation

- **[architecture.md](./architecture.md)** - System design, data flow, component relationships
- **[sync-logic.md](./sync-logic.md)** - SHA caching, change detection, conflict resolution, edge cases
- **[api-compatibility.md](./api-compatibility.md)** - Web API safety, cross-platform compatibility, forbidden patterns

## Roadmap & Priorities

### Current Release
**Milestone**: [1.4.0](https://github.com/joshuakto/fit/milestone/1)

Check the milestone for current release priorities and progress.

### Long-Term Strategic Priorities

**🛡️ Core Stability** (always active):
- **Data loss prevention** - Filesystem safety, reliable deletion handling
- **Sync reliability** - Handle edge cases, large files, encoding issues
- **Error diagnostics** - Clear per-file error feedback, actionable messages
- **Performance** - Fast syncs, efficient API usage, mobile optimization

**🚀 Platform Expansion**:
- **Hidden file support** - Enable syncing dotfiles (`.gitignore`, etc.)
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
- [Current milestone](https://github.com/joshuakto/fit/milestone/1) - Active release work
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
- ✅ E2E test execution
- 📊 Test coverage reporting (informational)
- 🔍 Security scanning via CodeQL

**Future security improvements**: We plan to enable Dependabot for automated dependency vulnerability scanning and updates.

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

**Quick Release**:
```shell
# Update minAppVersion in manifest.json first, then:
npm version patch   # bug fixes
npm version minor   # new features
npm version major   # breaking changes
```

**Manual Steps**:
1. Push that version bump commit and tag to GitHub
2. Run `npm run build`
3. Create GitHub release (use `1.0.1`, not `v1.0.1` with "v" prefix)
4. Upload `manifest.json`, `main.js`, `styles.css` as artifacts on the release

See [Obsidian Hub instructions](https://publish.obsidian.md/hub/04+-+Guides%2C+Workflows%2C+%26+Courses/Guides/How+to+release+a+new+version+of+your+plugin) for details.

---

## Code Quality

Please use your judgement and try to follow conventions from surrounding code to keep project quality high. Most critical project guidelines will be validated by GitHub checks on PRs, so there aren't too many strict requirements you need to follow.

**Linting**: Check for code style issues with `npm run lint` and automatically fix fixable issues with `npm run lint:fix`.

If you'd like to help set up more automated checking, there are a few quality aspects we don't have automated checks for but would like to:

- [ ] **ESLint rules** for TypeScript strict mode
- [ ] **Consistent documentation** to ensure comments and architecture docs stay up-to-date with code changes
- [ ] **Expand E2E tests** to cover mobile app on Android
- [ ] **Release automation/validation** to ensure releases are correctly configured & versioned
