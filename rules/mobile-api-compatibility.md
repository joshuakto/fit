---
title: "Mobile API compatibility"
scope: "file"
path: ["src/**/*.ts"]
severity_min: "critical"
---

## Instructions

This plugin runs in Obsidian's mobile environment, which has no Node.js. Code in `src/` must follow
the requirements in the document below, including the exceptions it states. That document is the
single source of truth: do not flag code that matches one of its documented exceptions.

@docs/api-compatibility.md
