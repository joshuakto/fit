#!/bin/sh
# When running inside a temp worktree (e.g. via hk), node_modules doesn't exist
# because it's gitignored. Symlink it from the main worktree so that npm
# scripts can resolve plugins and type definitions.
main=$(git worktree list | awk 'NR==1{print $1}')
if [ "$PWD" != "$main" ] && [ ! -d ./node_modules ]; then
    ln -sfn "$main/node_modules" ./node_modules
fi
npm run "$@"
