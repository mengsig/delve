#!/usr/bin/env bash
set -euo pipefail

source_dir="${1:?usage: collect-release-assets.sh <download-directory> <output-directory>}"
output_dir="${2:?usage: collect-release-assets.sh <download-directory> <output-directory>}"
[[ -d "$source_dir" && ! -e "$output_dir" ]] || { echo 'Expected an existing download directory and a new output directory.' >&2; exit 1; }
mkdir -p "$output_dir"
while IFS= read -r -d '' file; do
  name="${file##*/}"
  [[ ! -e "$output_dir/$name" ]] || { echo "Duplicate release asset: $name" >&2; exit 1; }
  cp -- "$file" "$output_dir/$name"
done < <(find "$source_dir" -type f -print0)

shopt -s nullglob
for pattern in '*.AppImage' '*.deb' '*.dmg' '*-setup.exe'; do
  matches=("$output_dir"/$pattern)
  (( ${#matches[@]} > 0 )) || { echo "Missing release asset: $pattern" >&2; exit 1; }
done
(
  cd "$output_dir"
  sha256sum -- * > SHA256SUMS
  sha256sum --check SHA256SUMS
)
