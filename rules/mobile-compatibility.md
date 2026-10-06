---
title: "Mobile API compatibility"
# @kody-sync
scope: "file"
path: ["src/**/*.ts", "esbuild.config.mjs", "esbuild.externals.mjs", "eslint.config.js"]
severity_min: "high"
---

## Instructions

The rules and their reasons are in the "Unsafe Patterns to Avoid" section of @docs/api-compatibility.md which is
the source of truth. Its "Automated Validation" section describes how `npm run lint` and `npm test` enforce them,
so do not second-guess code that passes both, and do not flag Node API usage those checks already reject.

Do flag changes the mechanical checks cannot judge: a new desktop-only exception that does not meet the
conditions in that document's "Desktop-only exceptions" section, or any weakening of the enforcement itself
(removing a lint rule or bundle-check case, or widening an allowlist without a documented reason).
