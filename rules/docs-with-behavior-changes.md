---
title: "Update docs with behavior changes"
# @kody-sync
scope: "pull-request"
path: ["src/**/*.ts"]
severity_min: "medium"
---

## Instructions

A pull request that changes sync logic or other user-visible behavior updates the docs that describe it in the
same pull request. The standard is in the "Documentation" section of @docs/CONTRIBUTING.md which is the source
of truth.

Judge this across the whole pull request, not per changed file or chunk: a doc update elsewhere in the same
pull request counts.

Do NOT comment to flag a violation unless you can see the full diff of the pull request and verify that the
relevant docs were not updated in it. If you can only see part of the diff (a single file or chunk), you cannot
tell, so say nothing. A missing doc change in the part you can see is not evidence: the doc update is usually
in a file you were not shown. When in doubt, do not comment.
