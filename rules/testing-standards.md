---
title: "Test quality standards"
scope: "file"
path: ["src/**/*.test.ts"]
severity_min: "medium"
---

## Instructions

Tests in this repo follow the "Testing" guidelines in `docs/CONTRIBUTING.md` § Code Quality, which are the
single source of truth, including their examples. Read that section before judging a test; do not flag a
test that matches an exception or placeholder allowance it states. In short:

- One test checks one thing; use parameterized tests for variations.
- Mock only true external boundaries (Obsidian's API), never our own `src/*.ts` modules.
- Prefer the fake vaults (`FakeLocalVault`/`FakeRemoteVault`) over spies on call sequences; reserve spies for
  proving something was not called.
- Assert observable behavior (file content, the returned result, a later sync), not internal bookkeeping.
- Assert the whole result object, not one indexed field, and explain each entry inline.
- Assert one complete value (`toEqual(expect.objectContaining(...))`), not its pieces, and not `toMatchObject`
  when a sibling field carries diagnostic information.
- Each test file starts with a header comment saying what it covers and how it differs from its siblings.
