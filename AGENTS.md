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

## Mobile API compatibility

The plugin must run on Obsidian mobile, which has no Node.js. This is enforced mechanically by `npm run lint` and `npm test` (ESLint rules plus a bundle check): if both pass, don't second-guess code against a summary of the rules. The specifics, the reasons, and how to allow a desktop-only exception are in [docs/api-compatibility.md](docs/api-compatibility.md) and `eslint.config.js`.

---

## Development Quick Reference

**Commands**: `npm test`, `npm run typecheck && npm run lint`
**Targeted test**: `npm test -- --testNamePattern="pattern"`
**Architecture**: Vaults (storage) → Fit/FitSync (sync logic) → src/fitPlugin.ts (Obsidian integration)
**Rules**: review rules for every change live in [rules/](rules/); follow the ones that apply to what you're touching.

---

## README maintenance

`README.md` always reflects the **current stable release**, not unreleased work: see [docs/CONTRIBUTING.md § Documentation](docs/CONTRIBUTING.md#documentation).
