#!/usr/bin/env bash
# Build, check and publish this plugin to ClawHub from a clean `main` checkout.
#
#   scripts/clawhub-publish.sh            # everything up to a dry run; uploads nothing
#   scripts/clawhub-publish.sh --publish  # the same, then the real publish (waits for ClawHub's checks)
#
# One-time setup: `npx --yes clawhub@0.23.3 login` (GitHub device code), then
# `npx --yes clawhub@0.23.3 whoami` must print the handle that matches the
# package scope (@sepivip). See RELEASING.md.
#
# It publishes the npm-pack tarball, not the folder: the folder path makes the
# CLI spawn `npm`, which fails with ENOENT on Windows.
set -euo pipefail

CLAWHUB="npx --yes clawhub@0.23.3"
REPO="sepivip/openclaw-channel-bitrix24"
export npm_config_ignore_scripts=true

PUBLISH=0
case "${1:-}" in
  "") ;;
  --publish) PUBLISH=1 ;;
  *) echo "usage: $0 [--publish]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "Switch to main first (currently on $branch)." >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "The working tree is not clean." >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
  echo "Local main differs from origin/main. Pull (or push) first." >&2; exit 1; }

COMMIT="$(git rev-parse HEAD)"
NAME="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"
echo "== $NAME $VERSION from $REPO@$COMMIT"

npm ci
rm -rf dist
npm run build
npm run typecheck
npm test

$CLAWHUB package validate . --out "$(mktemp -d)"   # reports go outside the repo

rm -f ./*.tgz
TGZ="$(npm pack --silent)"
echo "== packed $TGZ"

ARGS=(package publish "./$TGZ" --family code-plugin
  --source-repo "$REPO" --source-commit "$COMMIT" --source-ref main
  --topics "bitrix24,imbot,chatbot")

$CLAWHUB "${ARGS[@]}" --dry-run

if [ "$PUBLISH" = 1 ]; then
  echo "== publishing as:"
  $CLAWHUB whoami
  $CLAWHUB "${ARGS[@]}" --wait
  echo "== done. Check: $CLAWHUB package inspect $NAME"
else
  echo "== dry run only; nothing was uploaded. Re-run with --publish to publish."
fi
