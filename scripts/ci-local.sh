#!/usr/bin/env bash
# Runs the CI job (.github/workflows/ci.yml) locally in a clean Linux container, for when
# GitHub Actions is unavailable or to check Linux before pushing. Uses only committed files
# (a fresh `git clone` of HEAD), so untracked files and local node_modules can't hide problems.
#
# Usage: scripts/ci-local.sh [--image node:22-bookworm]
# Needs Docker. On Apple silicon the arm64 image is used (same Linux userland as CI).
set -euo pipefail
image="node:22-bookworm"
if [ "${1:-}" = "--image" ]; then image="${2:?--image needs a value}"; fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
bundle_dir="$(mktemp -d)"
trap 'rm -rf "$bundle_dir"' EXIT
git -C "$repo_root" bundle create "$bundle_dir/repo.bundle" HEAD >/dev/null 2>&1
echo "ci-local: testing $(git -C "$repo_root" rev-parse --short HEAD) in $image" >&2

# Runs as the image's unprivileged `node` user, like GitHub's runner user (some guards behave differently as root).
docker run --rm --user node -w /home/node -v "$bundle_dir:/bundle:ro" "$image" bash -euo pipefail -c '
  git clone -q /bundle/repo.bundle work
  cd work
  scripts/install-plugin-dependencies.sh
  npm run check
  npm test
'
