#!/bin/sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
installer=$repo/install.sh
root=$(mktemp -d "${TMPDIR:-/tmp}/delve-installer-tests.XXXXXX")
trap 'rm -rf "$root"' 0
trap 'exit 1' HUP INT TERM
mkdir -p "$root/bin"

cat > "$root/bin/uname" <<'MOCK'
#!/bin/sh
case ${1:-} in
  -s | '') printf '%s\n' "$MOCK_OS" ;;
  -m) printf '%s\n' "$MOCK_ARCH" ;;
  *) exit 1 ;;
esac
MOCK

cat > "$root/bin/curl" <<'MOCK'
#!/bin/sh
output=
url=
while [ "$#" -gt 0 ]; do
  case $1 in
    -o | --output) output=$2; shift 2 ;;
    -w | --write-out | --proto | --proto-redir) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ -n "$url" ] || exit 2
printf '%s\n' "$url" >> "$MOCK_LOG"
if [ "$url" = https://github.com/mengsig/delve/releases/latest ]; then
  printf '%s' 'https://github.com/mengsig/delve/releases/tag/v0.1.0'
  exit 0
fi
[ "$MOCK_DOWNLOAD" = checksum ] || [ "$MOCK_DOWNLOAD" = success ] || exit 22
case $url in
  */SHA256SUMS)
    if [ "$MOCK_DOWNLOAD" = success ]; then
      digest=$(sha256sum "$MOCK_PAYLOAD")
      printf '%s  %s\n' "${digest%% *}" "$MOCK_ASSET" > "$output"
    else
      printf '%064d  %s\n' 0 "$MOCK_ASSET" > "$output"
    fi ;;
  */"$MOCK_ASSET") cp "$MOCK_PAYLOAD" "$output" ;;
  *) exit 22 ;;
esac
MOCK

cat > "$root/bin/pgrep" <<'MOCK'
#!/bin/sh
exit 1
MOCK

cat > "$root/bin/hdiutil" <<'MOCK'
#!/bin/sh
printf '%s\n' 'hdiutil invoked before checksum verification' >&2
exit 99
MOCK
cat > "$root/payload" <<'MOCK'
#!/bin/sh
printf 'executed\n' > "$MOCK_MARKER"
mkdir -p squashfs-root/icons
printf 'icon\n' > squashfs-root/icons/delve.png
MOCK
chmod +x "$root/bin/uname" "$root/bin/curl" "$root/bin/hdiutil" "$root/bin/pgrep"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  if [ -f "$case_dir/output" ]; then cat "$case_dir/output" >&2; fi
  exit 1
}

run_installer() {
  name=$1 os=$2 arch=$3 asset=$4 mode=$5 version=$6
  case_dir=$root/$name
  mkdir -p "$case_dir/home" "$case_dir/tmp"
  : > "$case_dir/curl.log"
  if env -i PATH="$root/bin:/usr/bin:/bin" HOME="$case_dir/home" \
    TMPDIR="$case_dir/tmp" XDG_DATA_HOME="$case_dir/home/.local/share" \
    XDG_CONFIG_HOME="$case_dir/home/.config" DELVE_VERSION="$version" \
    MOCK_OS="$os" MOCK_ARCH="$arch" MOCK_ASSET="$asset" \
    MOCK_DOWNLOAD="$mode" MOCK_PAYLOAD="$root/payload" MOCK_MARKER="$case_dir/executed" MOCK_LOG="$case_dir/curl.log" \
    sh "$installer" > "$case_dir/output" 2>&1; then
    fail "$name: installer unexpectedly succeeded"
  fi
}

expect_url() {
  grep -Fx "$1" "$case_dir/curl.log" >/dev/null || fail "missing URL: $1"
}

release=https://github.com/mengsig/delve/releases/download/v0.1.0
linux_asset=Delve-0.1.0-x86_64.AppImage
mac_asset=Delve-0.1.0-arm64.dmg

run_installer linux-selection Linux x86_64 "$linux_asset" fail 0.1.0
expect_url "$release/$linux_asset"
run_installer mac-selection Darwin arm64 "$mac_asset" fail 0.1.0
expect_url "$release/$mac_asset"
run_installer latest-selection Linux x86_64 "$linux_asset" fail ''
expect_url 'https://github.com/mengsig/delve/releases/latest'
expect_url "$release/$linux_asset"

run_installer unsupported-architecture Linux aarch64 unused fail 0.1.0
grep -i 'unsupported' "$case_dir/output" >/dev/null || fail 'unsupported architecture was not explained'
[ ! -s "$case_dir/curl.log" ] || fail 'unsupported architecture triggered a download'

for platform in linux mac; do
  case $platform in
    linux) os=Linux arch=x86_64 asset=$linux_asset ;;
    mac) os=Darwin arch=arm64 asset=$mac_asset ;;
  esac
  run_installer "$platform-checksum" "$os" "$arch" "$asset" checksum 0.1.0
  expect_url "$release/$asset"
  expect_url "$release/SHA256SUMS"
  grep -F 'Checksum mismatch' "$case_dir/output" >/dev/null || fail 'checksum failure was not explained'
  [ ! -e "$case_dir/executed" ] || fail 'asset ran before checksum verification'
  if find "$case_dir/home" -type f -print | grep . >/dev/null; then
    fail 'checksum failure left installed files in HOME'
  fi
  if grep -F 'hdiutil invoked before checksum verification' "$case_dir/output" >/dev/null; then
    fail 'installation started before checksum verification'
  fi
done

case_dir=$root/linux-success
mkdir -p "$case_dir/home" "$case_dir/tmp"
: > "$case_dir/curl.log"
env -i PATH="$root/bin:/usr/bin:/bin" HOME="$case_dir/home" \
  TMPDIR="$case_dir/tmp" DELVE_VERSION=0.1.0 MOCK_OS=Linux MOCK_ARCH=x86_64 \
  MOCK_ASSET="$linux_asset" MOCK_DOWNLOAD=success MOCK_PAYLOAD="$root/payload" \
  MOCK_MARKER="$case_dir/executed" MOCK_LOG="$case_dir/curl.log" \
  sh "$installer" > "$case_dir/output" 2>&1 || fail 'valid checksum did not install'
[ -e "$case_dir/executed" ] || fail 'verified asset was not extracted'
[ -x "$case_dir/home/.local/share/delve/Delve.AppImage" ] || fail 'AppImage was not installed'
[ -L "$case_dir/home/.local/bin/delve" ] || fail 'launcher was not installed'

printf '%s\n' 'installer tests passed'
