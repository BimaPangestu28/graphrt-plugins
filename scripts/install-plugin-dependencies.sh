#!/usr/bin/env bash
# Installs the npm dependencies of every plugin that declares any (from its lockfile),
# so `npm test` can run the plugins' own tests. Used by CI; safe to run locally.
set -euo pipefail
cd "$(dirname "$0")/.."
for manifest in */package.json; do
  plugin_directory="$(dirname "$manifest")"
  dependency_count="$(node -p "Object.keys(require('./${plugin_directory}/package.json').dependencies || {}).length")"
  [ "$dependency_count" = "0" ] && continue
  if [ ! -f "$plugin_directory/package-lock.json" ]; then
    echo "::error::$plugin_directory declares dependencies but has no package-lock.json" >&2
    exit 1
  fi
  echo "== $plugin_directory: npm ci" >&2
  # Browser downloads are skipped: the tests use fakes; integration tests skip without a browser.
  (cd "$plugin_directory" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error)
done
