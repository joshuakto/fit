# FitPlugin - Agent Instructions

## Local overrides

**You MUST read @AGENTS.local.md before proceeding if it exists.** It contains personal workflow details, tool-specific conventions, and session startup instructions that take precedence over this file.

---

## Project

FIT is an Obsidian plugin that syncs vault files to GitHub. It must run on both desktop and mobile (Obsidian's mobile environment has no Node.js).

Core design tenets (never lose data, minimize forced user intervention, conservative opt-in for special files, minimize sync churn between clients): see [docs/architecture.md § Design Principles](docs/architecture.md#design-principles).

Key docs:
- **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** — setup, PR process, release workflow, roadmap and current milestone
- **[docs/architecture.md](docs/architecture.md)** — component overview
- **[docs/api-compatibility.md](docs/api-compatibility.md)** — what APIs are safe to use
- **[docs/sync-logic.md](docs/sync-logic.md)** — sync internals

When shipping a feature: update the relevant doc(s) above to reflect the new state.

---

## Critical: mobile API compatibility

The plugin runs in Obsidian's mobile environment with no Node.js. Violations cause silent failures or crashes on mobile.

- ❌ No `Buffer`, `process`, `require('fs')`, `require('util')`, or any Node.js built-ins
- ❌ No `new TextDecoder()` without `{ fatal: true }` — causes silent data corruption
- ✅ Use `vault.readBinary()` for file reads, not `vault.read()`
- ✅ Use Obsidian's `arrayBufferToBase64()` instead of `Buffer.from(...).toString('base64')`

See [docs/api-compatibility.md](docs/api-compatibility.md) for the full list.

---

## Development Quick Reference

**Commands**: `npm test`, `npm run typecheck && npm run lint`
**Targeted test**: `npm test -- --testNamePattern="pattern"`
**Architecture**: Vaults (storage) → Fit/FitSync (sync logic) → src/fitPlugin.ts (Obsidian integration)
**Testing conventions**: see [docs/CONTRIBUTING.md § Code Quality](docs/CONTRIBUTING.md#code-quality)

---

## README maintenance

`README.md` always reflects the **current stable release**. When something is fixed in a beta but not yet in stable:
- Do not remove or update README sections describing the unfixed behavior
- You may note the fix is available in beta, but don't present beta status as current general-availability status
- Clean up stale bug/workaround sections only once the stable release ships
