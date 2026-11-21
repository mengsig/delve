#!/usr/bin/env bash
# Usage: release-notes.sh <version> — prints the CHANGELOG.md section for that version.
set -euo pipefail

version="${1:?usage: release-notes.sh <version>}"
notes="$(awk -v v="$version" '
  /^## / { if (found) exit; if ($2 == "[" v "]" || $2 == v) found = 1; next }
  found { print }
' CHANGELOG.md)"

if [[ -z "${notes//[[:space:]]/}" ]]; then
  echo "CHANGELOG.md has no entry for version $version" >&2
  exit 1
fi
printf '%s\n' "$notes"
