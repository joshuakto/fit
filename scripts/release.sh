#!/bin/sh
# Release script for FIT plugin.
#
# Usage:
#   ./scripts/release.sh <alpha|beta|stable> [VERSION] [REF]
#
# Channels:
#   alpha   pre-release for early testing      (e.g. 1.6.0-alpha.1)
#   beta    pre-release for broader testing     (e.g. 1.6.0-beta.1)
#   stable  full release                        (e.g. 1.6.0)
#
# VERSION: semver string, or '-' to auto-compute (default: auto-compute)
# REF: git ref to promote — branch, tag, or commit (default: origin/main)
#   Use '-' for VERSION to pass REF without pinning the version:
#   ./scripts/release.sh alpha - my-feature-branch
#
# Patch releases (e.g. 1.5.1):
#   TODO: auto-version does not handle patch releases — it always targets the
#         next minor. Pass VERSION explicitly: ./scripts/release.sh stable 1.5.1
#
# What this script does:
#   1. Pre-flight: typecheck, lint, unit tests
#   2. Compute or validate VERSION
#   3. Fetch REF; apply version bump to its files in a temp dir (no working copy changes)
#   4. Create a git commit object from that tree; tag it
#   5. For stable: also push the commit to main
#   6. Create draft GitHub release (prerelease flag for alpha/beta)
#   7. CI (release-assets.yml) builds from the tag and attaches main.js, styles.css, manifest.json
#   8. Print comms next steps

set -e

CHANNEL="$1"
VERSION_ARG="$2"
REF_ARG="$3"

case "$CHANNEL" in
    alpha|beta|stable) ;;
    *)
        printf 'Usage: %s <alpha|beta|stable> [VERSION] [REF]\n' "$0" >&2
        exit 1
        ;;
esac

# ── Pre-flight ────────────────────────────────────────────────────────────────
printf '==> Pre-flight: typecheck + lint + tests\n'
npm run typecheck
npm run lint
npm test

# ── Resolve base ref ──────────────────────────────────────────────────────────
# Strip '-' placeholder; default to origin/main.
if [ -z "$REF_ARG" ] || [ "$REF_ARG" = "-" ]; then
    BASE_REF="origin/main"
elif printf '%s' "$REF_ARG" | grep -qv '/'; then
    # Bare branch name — qualify with origin/ to avoid local/remote ambiguity
    BASE_REF="origin/$REF_ARG"
else
    BASE_REF="$REF_ARG"
fi

# Strip '-' placeholder from VERSION_ARG so next-version.mjs sees empty string.
if [ "$VERSION_ARG" = "-" ]; then
    VERSION_ARG=""
fi

# ── Version ───────────────────────────────────────────────────────────────────
# Fetch now so BASE_REF resolves and we can read its current version.
git fetch origin main
BASE_VERSION=$(git show "$BASE_REF":package.json | node -p \
    "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
VERSION=$(node scripts/next-version.mjs "$CHANNEL" "$VERSION_ARG" "$BASE_VERSION")
case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) printf 'Error: computed version %s does not look like semver.\n' "$VERSION" >&2; exit 1 ;;
esac
printf '==> Channel: %s  Version: %s\n' "$CHANNEL" "$VERSION"

if gh release view "$VERSION" > /dev/null 2>&1; then
    printf 'Error: release %s already exists.\n' "$VERSION" >&2
    exit 1
fi

# ── Build release commit from REF ─────────────────────────────────────────────
# Apply version bump to files extracted from BASE_REF in a temp dir.
# The working copy is never touched; the script can run from any branch.
printf '==> Applying version bump to %s...\n' "$BASE_REF"
PARENT=$(git rev-parse "$BASE_REF")
REPOROOT=$(git rev-parse --show-toplevel)
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

git show "$PARENT":manifest.json  > "$TMPDIR/manifest.json"
git show "$PARENT":versions.json  > "$TMPDIR/versions.json"
git show "$PARENT":package.json   > "$TMPDIR/package.json"

# version-bump.mjs reads/writes manifest.json and versions.json relative to CWD
(cd "$TMPDIR" && npm_package_version="$VERSION" node "$REPOROOT/version-bump.mjs")

# Update package.json version field
node -e "
const fs = require('fs'), f = '$TMPDIR/package.json';
const p = JSON.parse(fs.readFileSync(f, 'utf8'));
p.version = '$VERSION';
fs.writeFileSync(f, JSON.stringify(p, null, '\t') + '\n');
"

# Build git blobs for the three changed files
MANIFEST_BLOB=$(git hash-object -w "$TMPDIR/manifest.json")
VERSIONS_BLOB=$(git hash-object -w "$TMPDIR/versions.json")
PKG_BLOB=$(git hash-object -w "$TMPDIR/package.json")

# Build the release tree by taking BASE_REF's root tree entries and swapping
# in the updated blobs. Uses no index — avoids conflicts with jj's index lock.
TREE=$(git ls-tree "$PARENT" | while IFS='	' read -r meta path; do
    mode=$(printf '%s' "$meta" | cut -d' ' -f1)
    type=$(printf '%s' "$meta" | cut -d' ' -f2)
    sha=$(printf '%s' "$meta" | cut -d' ' -f3)
    case "$path" in
        manifest.json) sha="$MANIFEST_BLOB" ;;
        versions.json) sha="$VERSIONS_BLOB" ;;
        package.json)  sha="$PKG_BLOB" ;;
    esac
    printf '%s %s %s\t%s\n' "$mode" "$type" "$sha" "$path"
done | git mktree)

if [ "$CHANNEL" = "stable" ]; then
    COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "release: $VERSION")
else
    COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "chore: release $VERSION")
fi
git tag "$VERSION" "$COMMIT"

# ── Push ──────────────────────────────────────────────────────────────────────
if [ "$CHANNEL" = "stable" ]; then
    printf '==> Pushing to main...\n'
    git push origin "$COMMIT":refs/heads/main
fi
printf '==> Pushing tag %s\n' "$VERSION"
git push origin "$VERSION"

# ── GitHub release ────────────────────────────────────────────────────────────
printf '==> Creating draft GitHub release...\n'

if [ "$CHANNEL" = "stable" ]; then
    gh release create "$VERSION" \
        --draft \
        --latest \
        --generate-notes \
        --title "$VERSION"
else
    gh release create "$VERSION" \
        --draft \
        --prerelease \
        --latest=false \
        --generate-notes \
        --title "$VERSION"
fi

RELEASE_URL=$(gh release view "$VERSION" --json url -q .url)

printf '
==> Draft release created. CI is attaching build artifacts now.
    Edit release notes and publish when ready:
    %s
' "$RELEASE_URL"

# ── Comms next steps ──────────────────────────────────────────────────────────
if [ "$CHANNEL" = "stable" ]; then
    printf '
==> README: Apply pending changes listed in docs/CONTRIBUTING.md
    (search for "Pending README changes for next stable release")
    then commit and push before publishing the release.

==> Comms: Ask the head maintainer to post a release announcement:
    https://github.com/joshuakto/fit/discussions/categories/announcements
'
else
    printf '
==> Comms: Post an alpha/beta announcement in Beta Testing:
    https://github.com/joshuakto/fit/discussions/categories/beta-testing
'
fi
