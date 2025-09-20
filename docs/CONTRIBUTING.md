# FIT Developer Guide

Developer documentation for the FIT (File gIT) Obsidian plugin.

## Quick Start

```shell
git clone https://github.com/joshuakto/fit.git
cd fit && npm install
npm run dev
```

**Testing**: Copy `main.js`, `styles.css`, `manifest.json` to `.obsidian/plugins/fit/` in a test vault.

**Unit Tests**: Run `npm test` to execute Jest unit tests, or `npm run test:watch` for development.

## Architecture

See [`architecture.md`](./architecture.md) for system design, data flow, and component relationships.

## Getting Help

- **Questions**: [GitHub Discussions](https://github.com/joshuakto/fit/discussions)
- **Bugs**: [GitHub Issues](https://github.com/joshuakto/fit/issues)

## Contributing

### Pull Request Process

1. **Create feature/bug branch** from `main`
2. **Make your changes** following existing code patterns
3. **Submit PR** with clear description

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
1. Run `npm run build`
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
- [ ] **Functional tests** to ensure mobile compatibility
- [ ] **Release automation/validation** to ensure releases are correctly configured & versioned
