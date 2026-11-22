#!/bin/sh
set -eu

releases=https://github.com/mengsig/delve/releases
share=$HOME/.local/share/delve
bin=$HOME/.local/bin/delve
desktop=$HOME/.local/share/applications/delve.desktop
icon=$HOME/.local/share/icons/hicolor/256x256/apps/delve.png
mount=
tmp=

die() { printf 'Delve: %s\n' "$*" >&2; exit 1; }
cleanup() {
  if [ -n "$mount" ]; then hdiutil detach "$mount" >/dev/null || printf 'Delve: could not detach %s\n' "$mount" >&2; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

usage() {
  printf 'Usage: sh install.sh [--uninstall|--help]\nSet DELVE_VERSION to install a specific release.\n'
}
ensure_stopped() {
  if command -v pgrep >/dev/null 2>&1 && { pgrep -x Delve >/dev/null 2>&1 || pgrep -x delve.bin >/dev/null 2>&1; }; then
    die 'Please quit Delve before installing or uninstalling it.'
  fi
}
uninstall() {
  ensure_stopped
  case $(uname -s) in
    Linux)
      if [ -L "$bin" ] && [ "$(readlink "$bin")" = "$share/launch" ]; then rm "$bin"; fi
      rm -f "$desktop" "$icon"
      rm -rf "$share"
      ;;
    Darwin)
      if [ -f "$share/mac-install-dir" ]; then
        IFS= read -r app_dir < "$share/mac-install-dir" || die 'Invalid installation record.'
        case $app_dir in /Applications|"$HOME/Applications") ;; *) die 'Invalid installation record.' ;; esac
        rm -rf "$app_dir/Delve.app"
        rm -f "$share/mac-install-dir"
        rmdir "$share" 2>/dev/null || :
      fi
      ;;
    *) die "This platform is unsupported, not supported yet. See $releases" ;;
  esac
  printf 'Delve uninstalled.\n'
}

case ${1:-} in
  --help) usage; exit 0 ;;
  --uninstall) [ "$#" -eq 1 ] || die 'Unexpected arguments.'; uninstall; exit 0 ;;
  '') [ "$#" -eq 0 ] || die 'Unexpected arguments.' ;;
  *) usage >&2; exit 1 ;;
esac

os=$(uname -s)
arch=$(uname -m)
case $os:$arch in
  Linux:x86_64|Linux:amd64) platform=linux ;;
  Darwin:arm64) platform=mac ;;
  *) die "$os $arch is unsupported, not supported yet. See $releases" ;;
esac
ensure_stopped
command -v curl >/dev/null 2>&1 || die 'curl is required.'
if [ -n "${DELVE_VERSION:-}" ]; then
  version=${DELVE_VERSION#v}
else
  latest=$(curl -fsSL --proto '=https' --proto-redir '=https' -o /dev/null -w '%{url_effective}' "$releases/latest") || die 'Could not find the latest release.'
  case $latest in "$releases"/tag/*) version=${latest##*/} ;; *) die 'Unexpected latest release URL.' ;; esac
  version=${version#v}
fi
case $version in ''|*[!0-9A-Za-z._-]*|.*|-*) die 'Invalid release version.' ;; esac
case $platform in
  linux) asset=Delve-$version-x86_64.AppImage ;;
  mac) asset=Delve-$version-arm64.dmg ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/delve-install.XXXXXXXX") || die 'Could not create a temporary directory.'
url=$releases/download/v$version
printf 'Installing Delve %s...\n' "$version"
curl -fLsS --proto '=https' --proto-redir '=https' -o "$tmp/$asset" "$url/$asset" || die 'Could not download the release.'
curl -fLsS --proto '=https' --proto-redir '=https' -o "$tmp/SHA256SUMS" "$url/SHA256SUMS" || die 'Could not download SHA256SUMS.'
expected=$(awk -v file="$asset" '$2 == file || $2 == "*" file { print $1 }' "$tmp/SHA256SUMS")
case $expected in ''|*[!0-9a-fA-F]*) die "Missing or invalid checksum for $asset." ;; esac
[ "${#expected}" -eq 64 ] || die "Missing or invalid checksum for $asset."
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset")
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset")
else
  die 'sha256sum or shasum is required.'
fi
actual=${actual%% *}
[ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ] || die "Checksum mismatch for $asset; installation aborted."
printf 'Checksum verified.\n'

install_linux() {
  chmod +x "$tmp/$asset"
  (cd "$tmp" && "./$asset" --appimage-extract >/dev/null) || die 'Could not extract the app icon.'
  source_icon=$(find "$tmp/squashfs-root" -type f -name '*.png' | head -n 1)
  [ -n "$source_icon" ] || die 'AppImage has no PNG icon.'
  if [ -e "$bin" ] || [ -L "$bin" ]; then
    [ -L "$bin" ] && [ "$(readlink "$bin")" = "$share/launch" ] || die "$bin already exists. Please move it first."
  fi
  mkdir -p "$share" "${bin%/*}" "${desktop%/*}" "${icon%/*}"
  mv "$tmp/$asset" "$share/Delve.AppImage.new"
  mv -f "$share/Delve.AppImage.new" "$share/Delve.AppImage"
  cp "$source_icon" "$icon"
  cat > "$share/launch" <<'LAUNCH'
#!/bin/sh
exec "$HOME/.local/share/delve/Delve.AppImage" --appimage-extract-and-run "$@"
LAUNCH
  chmod +x "$share/launch"
  ln -sf "$share/launch" "$bin"
  escaped=$(printf '%s' "$share/launch" | sed 's/[\\"`$]/\\&/g')
  cat > "$desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Delve
Exec="$escaped" %U
Icon=delve
Categories=Education;
Terminal=false
MimeType=x-scheme-handler/delve;
DESKTOP
  case :$PATH: in *:"$HOME/.local/bin":*) ;; *) printf 'Add %s/.local/bin to PATH to run delve from a terminal.\n' "$HOME" ;; esac
  printf 'Installed to %s. Start Delve from your app launcher or run delve.\n' "$share/Delve.AppImage"
}
install_mac() {
  app_dir=${DELVE_INSTALL_DIR:-/Applications}
  case $app_dir in /Applications|"$HOME/Applications") ;; *) die 'DELVE_INSTALL_DIR must be /Applications or ~/Applications.' ;; esac
  if [ "$app_dir" = /Applications ] && [ ! -w "$app_dir" ]; then app_dir=$HOME/Applications; fi
  mkdir -p "$app_dir" "$share"
  mount=$tmp/mount
  mkdir "$mount"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$tmp/$asset" >/dev/null || { mount=; die 'Could not mount the disk image.'; }
  [ -d "$mount/Delve.app" ] || die 'Disk image does not contain Delve.app.'
  ditto "$mount/Delve.app" "$tmp/Delve.app" || die 'Could not copy Delve.app.'
  hdiutil detach "$mount" >/dev/null || die 'Could not detach the disk image.'
  mount=
  if [ -e "$app_dir/Delve.app" ]; then mv "$app_dir/Delve.app" "$tmp/previous.app" || die 'Could not replace Delve.app.'; fi
  if ! mv "$tmp/Delve.app" "$app_dir/Delve.app"; then
    if [ -e "$tmp/previous.app" ]; then mv "$tmp/previous.app" "$app_dir/Delve.app" || die 'Could not restore previous app.'; fi
    die 'Could not install Delve.app.'
  fi
  printf '%s\n' "$app_dir" > "$share/mac-install-dir"
  if ! xattr -dr com.apple.quarantine "$app_dir/Delve.app" 2>/dev/null; then
    attributes=$(xattr -lr "$app_dir/Delve.app") || die 'Could not inspect app attributes.'
    case $attributes in *com.apple.quarantine*) die 'Could not remove quarantine from Delve.app.' ;; esac
  fi
  printf 'Installed to %s/Delve.app. Open Delve from Applications.\n' "$app_dir"
}
case $platform in linux) install_linux ;; mac) install_mac ;; esac
