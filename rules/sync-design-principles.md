---
title: "Sync design principles"
# @kody-sync
scope: "pull-request"
path: ["src/**/*.ts"]
severity_min: "medium"
---

## Instructions

Check a change to sync, merge, conflict or path-tracking behavior against the "Design Principles" section of
@docs/architecture.md which is the source of truth, including its examples of what to do and what not to do.

Only flag a change that clearly works against one of them. A change that doesn't touch sync behavior (a
refactor, logging, UI text) is out of scope.
