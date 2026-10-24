#!/bin/sh
# Score the checked-in fixtures in a private directory.
# A shared /tmp/apply-lens path would pick up stale captures and follow
# planted symlinks (cp follows a destination symlink).
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d "${TMPDIR:-/tmp}/apply-lens.XXXXXX")
cleanup() {
  rm -rf "$dir"
}
trap cleanup EXIT
cp "$root"/docs/fixtures/page-*.json "$dir"/
python3 "$root"/src/score.py --root "$dir"
