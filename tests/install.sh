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
if [ "$MOCK_DOWNLOAD" != success ]; then
  printf '%s\n' 'hdiutil invoked before checksum verification' >&2
  exit 99
fi
case $1 in
  attach) cp -RP "$MOCK_BUNDLE" "$5/Delve.app" ;;
  detach) [ -d "$2/Delve.app" ] ;;
  *) exit 1 ;;
esac
MOCK
cat > "$root/bin/ditto" <<'MOCK'
#!/bin/sh
exec cp -RP "$@"
MOCK
cat > "$root/bin/xattr" <<'MOCK'
#!/bin/sh
[ "$1" = -dr ] && [ "$2" = com.apple.quarantine ] && [ -d "$3" ]
MOCK
cat > "$root/payload" <<'MOCK'
#!/bin/sh
case $1 in
  --appimage-extract)
    printf 'extracting files\n'
    printf 'executed\n' > "$MOCK_MARKER"
    mkdir -p squashfs-root/icons
    printf 'icon\n' > squashfs-root/icons/delve.png ;;
  --appimage-extract-and-run)
    printf 'extracting files\n'
    printf 'Diagnostic for %s\n' "$2" >&2
    exit 7 ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$root/bin/"*

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  if [ -f "$case_dir/output" ]; then cat "$case_dir/output" >&2; fi
  exit 1
}

prepare_case() {
  case_dir=$root/$1
  os=$2 arch=$3 asset=$4 mode=$5 version=$6
  home=$case_dir/home
  test_path=$root/bin:/usr/bin:/bin
  login_shell=/bin/bash
  mkdir -p "$home" "$case_dir/tmp"
}

isolated() {
  env -i PATH="$test_path" HOME="$home" SHELL="$login_shell" \
    TMPDIR="$case_dir/tmp" DELVE_VERSION="$version" DELVE_INSTALL_DIR="$home/Applications" \
    MOCK_OS="$os" MOCK_ARCH="$arch" MOCK_ASSET="$asset" MOCK_DOWNLOAD="$mode" \
    MOCK_PAYLOAD="$root/payload" MOCK_MARKER="$case_dir/executed" MOCK_LOG="$case_dir/curl.log" \
    MOCK_BUNDLE="$root/Delve.app" "$@" > "$case_dir/output" 2>&1
}

invoke_installer() {
  : > "$case_dir/curl.log"
  isolated sh "$installer" "$@"
}

expect_failure() {
  prepare_case "$@"
  if invoke_installer; then
    fail "$1: installer unexpectedly succeeded"
  fi
}

expect_url() {
  grep -Fx "$1" "$case_dir/curl.log" >/dev/null || fail "missing URL: $1"
}

release=https://github.com/mengsig/delve/releases/download/v0.1.0
linux_asset=Delve-0.1.0-x86_64.AppImage
mac_asset=Delve-0.1.0-arm64.dmg

expect_failure linux-selection Linux x86_64 "$linux_asset" fail 0.1.0
expect_url "$release/$linux_asset"
expect_failure mac-selection Darwin arm64 "$mac_asset" fail 0.1.0
expect_url "$release/$mac_asset"
expect_failure latest-selection Linux x86_64 "$linux_asset" fail ''
expect_url 'https://github.com/mengsig/delve/releases/latest'
expect_url "$release/$linux_asset"

expect_failure unsupported-architecture Linux aarch64 unused fail 0.1.0
grep -i 'unsupported' "$case_dir/output" >/dev/null || fail 'unsupported architecture was not explained'
[ ! -s "$case_dir/curl.log" ] || fail 'unsupported architecture triggered a download'

for platform in linux mac; do
  case $platform in
    linux) os=Linux arch=x86_64 asset=$linux_asset ;;
    mac) os=Darwin arch=arm64 asset=$mac_asset ;;
  esac
  expect_failure "$platform-checksum" "$os" "$arch" "$asset" checksum 0.1.0
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

expect_output() {
  grep -Fq -- "$1" "$case_dir/output" || fail "missing output: $1"
}

expect_absent() {
  [ ! -e "$1" ] && [ ! -L "$1" ] || fail "unexpected path: $1"
}

prepare_case linux-success Linux x86_64 "$linux_asset" success 0.1.0
share=$home/.local/share/delve
bin=$home/.local/bin/delve
desktop=$home/.local/share/applications/delve.desktop
icon=$home/.local/share/icons/hicolor/256x256/apps/delve.png
mkdir -p "$share/foreign" "$share/foreign-empty"
printf 'foreign file\n' > "$share/foreign.txt"
printf 'nested foreign file\n' > "$share/foreign/keep"

invoke_installer || fail 'valid checksum did not install'
[ -e "$case_dir/executed" ] || fail 'verified asset was not extracted'
[ -x "$share/Delve.AppImage" ] || fail 'AppImage was not installed'
[ -L "$bin" ] || fail 'launcher was not installed'
expect_output 'Next:'
expect_output 'Add to ~/.bashrc:'
expect_output "export PATH=\"\$HOME/.local/bin:\$PATH\""
if grep -Fq 'extracting files' "$case_dir/output"; then fail 'installer printed extraction output'; fi

first_digest=$(sha256sum "$share/Delve.AppImage" "$share/launch" "$desktop" "$icon")
login_shell=/bin/zsh
invoke_installer || fail 'reinstall failed'
expect_output 'Delve v0.1.0 is already installed: reinstalled'
expect_output 'Add to ~/.zshrc:'
[ "$first_digest" = "$(sha256sum "$share/Delve.AppImage" "$share/launch" "$desktop" "$icon")" ] ||
  fail 'reinstall changed file contents'

login_shell=/usr/bin/fish
version=0.2.0 asset=Delve-0.2.0-x86_64.AppImage
invoke_installer || fail 'update failed'
expect_output 'Updated v0.1.0 → v0.2.0'
expect_output "fish_add_path \"\$HOME/.local/bin\""

test_path=$home/.local/bin:$test_path
invoke_installer || fail 'reinstall with PATH set failed'
expect_output 'Open Delve from your app menu or run delve.'
if grep -Fq 'fish_add_path' "$case_dir/output"; then fail 'PATH hint appeared with install bin dir on PATH'; fi

if isolated delve 'test argument'; then fail 'launcher hid the application exit code'; else status=$?; fi
[ "$status" -eq 7 ] || fail "launcher returned $status, expected 7"
expect_output 'Starting Delve...'
expect_output 'Diagnostic for test argument'
if grep -Fq 'extracting files' "$case_dir/output"; then fail 'launcher printed extraction output'; fi

invoke_installer --uninstall || fail 'uninstall failed'
expect_output "Removed $share/Delve.AppImage"
expect_output "Left $share"
expect_output 'Delve uninstalled.'
for path in "$share/Delve.AppImage" "$share/launch" "$bin" "$desktop" "$icon" "$share/installed-version"; do
  expect_absent "$path"
done
[ "$(cat "$share/foreign.txt")" = 'foreign file' ] || fail 'uninstall removed or changed a pre-existing file'
[ "$(cat "$share/foreign/keep")" = 'nested foreign file' ] || fail 'uninstall removed or changed a pre-existing directory'
[ -d "$share/foreign-empty" ] || fail 'uninstall removed a pre-existing empty directory'

invoke_installer || fail 'install after uninstall failed'
mv "${desktop%/*}" "$case_dir/desktop-files"
ln -s "$case_dir/desktop-files" "${desktop%/*}"
rm "$icon"
ln -s "$share/foreign.txt" "$icon"
invoke_installer --uninstall || fail 'uninstall with symlinks failed'
expect_output "Left $desktop"
expect_output "Left $icon"
[ -s "$case_dir/desktop-files/delve.desktop" ] || fail 'uninstall followed symlinked desktop directory'
[ -L "$icon" ] && [ "$(cat "$icon")" = 'foreign file' ] || fail 'uninstall modified unrelated icon symlink'

prepare_case linux-foreign-only Linux x86_64 "$linux_asset" success 0.1.0
mkdir -p "$home/.local/share/applications"
printf 'foreign desktop entry\n' > "$home/.local/share/applications/delve.desktop"
invoke_installer --uninstall || fail 'uninstall without an installation failed'
[ "$(cat "$home/.local/share/applications/delve.desktop")" = 'foreign desktop entry' ] ||
  fail 'uninstall removed foreign desktop entry without a previous installation'

mkdir -p "$root/Delve.app/Contents/Frameworks/Mock Framework.framework/Versions/A"
printf 'mock application\n' > "$root/Delve.app/Contents/program"
printf 'mock framework\n' > "$root/Delve.app/Contents/Frameworks/Mock Framework.framework/Versions/A/file"
ln -s A "$root/Delve.app/Contents/Frameworks/Mock Framework.framework/Versions/Current"
prepare_case mac-success Darwin arm64 "$mac_asset" success 0.1.0
app=$home/Applications/Delve.app
invoke_installer || fail 'macOS install failed'
expect_output 'Next:'
invoke_installer || fail 'macOS reinstall failed'
expect_output 'Delve v0.1.0 is already installed: reinstalled'
invoke_installer --uninstall || fail 'macOS uninstall failed'
expect_absent "$app"

invoke_installer || fail 'macOS install after uninstall failed'
printf 'foreign bundle file\n' > "$app/Contents/keep"
framework=$app/Contents/Frameworks/Mock\ Framework.framework
mv "$framework/Versions/A" "$case_dir/external"
ln -s "$case_dir/external" "$framework/Versions/A"
if invoke_installer; then fail 'macOS reinstall accepted a modified bundle'; fi
expect_output 'differs from the installer file list'
invoke_installer --uninstall || fail 'macOS uninstall of modified bundle failed'
expect_absent "$app/Contents/program"
expect_absent "$framework/Versions/Current"
[ "$(cat "$app/Contents/keep")" = 'foreign bundle file' ] || fail 'macOS uninstall removed a foreign file'
[ "$(cat "$case_dir/external/file")" = 'mock framework' ] || fail 'macOS uninstall followed a bundle symlink'
expect_output "Left $app"

prepare_case mac-legacy Darwin arm64 "$mac_asset" success 0.1.0
app=$home/Applications/Delve.app
mkdir -p "$home/Applications" "$home/.local/share/delve"
cp -RP "$root/Delve.app" "$app"
printf '%s\n' "$home/Applications" > "$home/.local/share/delve/mac-install-dir"
invoke_installer --uninstall || fail 'uninstall with a legacy macOS record failed'
expect_output 'installed without a file list'
[ -f "$app/Contents/program" ] || fail 'uninstall deleted a bundle without a file list'
invoke_installer || fail 'could not adopt a legacy macOS installation'
invoke_installer --uninstall || fail 'could not uninstall the adopted macOS installation'
expect_absent "$app"

printf '%s\n' 'installer tests passed'
