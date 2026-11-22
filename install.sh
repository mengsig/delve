#!/bin/sh
set -eu

die() { printf 'Delve: %s\n' "$*" >&2; exit 1; }
case ${HOME:-} in /*) ;; *) die 'HOME must be an absolute path.' ;; esac

releases=https://github.com/mengsig/delve/releases
share=$HOME/.local/share/delve
appimage=$share/Delve.AppImage
launcher=$share/launch
version_file=$share/installed-version
mac_location=$share/mac-install-dir
tab=$(printf '\t')
bin=$HOME/.local/bin/delve
desktop=$HOME/.local/share/applications/delve.desktop
icon=$HOME/.local/share/icons/hicolor/256x256/apps/delve.png
mount=
tmp=
stage=
backup=
pending_receipt=

cleanup_stage() {
  if [ -z "$stage" ]; then return; fi
  if [ -n "$backup" ] && [ -d "$backup" ]; then
    if safe_directory "$app_dir" && [ ! -e "$mac_app" ] && [ ! -L "$mac_app" ] &&
      mv "$backup" "$mac_app"; then
      printf 'Restored %s\n' "$mac_app" >&2
    else
      printf 'Delve: recover the previous application from %s.\n' "$backup" >&2
      return
    fi
  fi
  rm -rf "$stage"
}
cleanup() {
  if [ -n "$mount" ]; then hdiutil detach "$mount" >/dev/null || printf 'Delve: could not detach %s\n' "$mount" >&2; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  if [ -n "$pending_receipt" ]; then rm -f "$pending_receipt"; fi
  cleanup_stage
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

usage() {
  printf 'Usage: sh install.sh [--uninstall|--help]\nSet DELVE_VERSION to install a specific release.\n'
}
ensure_stopped() {
  if command -v pgrep >/dev/null 2>&1 && { pgrep -x Delve >/dev/null 2>&1 || pgrep -x delve.bin >/dev/null 2>&1; }; then
    die 'Please quit Delve before installing or uninstalling it.'
  fi
}
valid_version() {
  case $1 in ''|*[!0-9A-Za-z._-]*|.*|-*) return 1 ;; esac
}
safe_directory() {
  case $1 in ''|/) return 0 ;; esac
  safe_directory "${1%/*}" || return 1
  [ ! -L "$1" ] && { [ ! -e "$1" ] || [ -d "$1" ]; }
}

leave() { printf 'Left %s\n' "$1"; }
defer_removal() {
  uninstall_pending=yes
  leave "$1"
}

report_uninstall() {
  if [ "$uninstall_pending" = yes ]; then
    printf 'Delve uninstall is incomplete. Fix the paths listed above and retry.\n'
    return
  fi
  if [ -L "$1" ] || [ -e "$1" ]; then
    printf 'Delve uninstall finished.\n'
  else
    printf 'Delve uninstalled.\n'
  fi
}

remove_entry() {
  if ! safe_directory "${1%/*}"; then
    defer_removal "$1 (parent is a symlink or is not a directory)"
    return
  fi
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return; fi
  case $2 in
    d)
      if [ -L "$1" ] || [ ! -d "$1" ]; then
        defer_removal "$1 (unexpected file type)"
        return
      fi
      if ! rmdir "$1" 2>/dev/null; then
        leave "$1 and its remaining contents"
        return
      fi
      ;;
    f|l)
      if { [ "$2" = f ] && { [ -L "$1" ] || [ ! -f "$1" ]; }; } ||
        { [ "$2" = l ] && [ ! -L "$1" ]; }; then
        defer_removal "$1 (unexpected file type)"
        return
      fi
      rm -f "$1" || die "Could not remove $1."
      ;;
    *) die 'Invalid installation record.' ;;
  esac
  if [ "${3:-}" = bundle ]; then
    bundle_removed=$((bundle_removed + 1))
  else
    printf 'Removed %s\n' "$1"
  fi
}

installed_bin() { [ -L "$bin" ] && [ "$(readlink "$bin")" = "$launcher" ]; }
has_linux_receipt() { [ ! -L "$version_file" ] && [ -f "$version_file" ]; }
linux_installation_present() {
  safe_directory "$share" || return 1
  if has_linux_receipt; then return 0; fi
  # The original installer had no version record.
  # shellcheck disable=SC2016
  [ ! -L "$launcher" ] && [ -f "$launcher" ] &&
    grep -Fq 'exec "$HOME/.local/share/delve/Delve.AppImage" --appimage-extract-and-run "$@"' "$launcher"
}

uninstall_linux() {
  safe_directory "$share" || die "$share contains a symlink or is not a directory. Left existing files in place."
  if ! linux_installation_present; then
    printf 'No Delve installation found. Left existing files in place.\n'
    return
  fi
  if ! safe_directory "${bin%/*}"; then
    defer_removal "$bin (parent is a symlink or is not a directory)"
  elif installed_bin; then
    remove_entry "$bin" l
  elif [ -e "$bin" ] || [ -L "$bin" ]; then
    leave "$bin (points elsewhere or is not a symlink)"
  fi
  for path in "$appimage" "$desktop" "$icon"; do
    remove_entry "$path" f
  done
  if [ "$uninstall_pending" = no ] || has_linux_receipt; then
    remove_entry "$launcher" f
  else
    leave "$launcher (kept to retry uninstall)"
  fi
  if [ "$uninstall_pending" = yes ]; then
    if has_linux_receipt; then leave "$version_file (kept to retry uninstall)"; fi
  else
    if has_linux_receipt; then remove_entry "$version_file" f; fi
    remove_entry "$share" d
  fi
  report_uninstall "$appimage"
}

read_mac_receipt() {
  [ ! -L "$mac_location" ] && [ -f "$mac_location" ] || die 'Invalid installation record.'
  {
    IFS= read -r recorded_dir || die 'Invalid installation record.'
    recorded_version=
    if IFS= read -r recorded_version; then
      valid_version "$recorded_version" || die 'Invalid installed version.'
    fi
  } < "$mac_location"
  case $recorded_dir in /Applications|"$HOME/Applications") ;; *) die 'Invalid installation record.' ;; esac
}

remove_mac_bundle() {
  bundle_removed=0
  {
    IFS= read -r location || die 'Invalid installation record.'
    IFS= read -r installed_version || die 'Invalid installation record.'
    [ "$location" = "$recorded_dir" ] && [ "$installed_version" = "$recorded_version" ] ||
      die 'Installation record changed during uninstall.'
    while IFS=$tab read -r type entry; do
      case /$entry/ in */../*|*/./*|*//*) die 'Invalid installation record.' ;; esac
      case $entry in
        Delve.app/*) remove_entry "$recorded_dir/$entry" "$type" bundle ;;
        Delve.app) [ "$type" = d ] || die 'Invalid installation record.' ;;
        *) die 'Invalid installation record.' ;;
      esac
    done
  } < "$mac_location"
  if [ "$bundle_removed" -gt 0 ]; then
    printf 'Removed %s recorded files and directories from %s/Delve.app\n' "$bundle_removed" "$recorded_dir"
  fi
  remove_entry "$recorded_dir/Delve.app" d
}

uninstall_mac() {
  if ! safe_directory "$share"; then leave "$share (unsafe path)"; return; fi
  if [ ! -e "$mac_location" ] && [ ! -L "$mac_location" ]; then
    printf 'No macOS installation record found.\n'
    return
  fi
  read_mac_receipt
  if ! safe_directory "$recorded_dir"; then leave "$recorded_dir (unsafe path)"; return; fi
  if [ -n "$recorded_version" ]; then
    remove_mac_bundle
  elif [ -e "$recorded_dir/Delve.app" ] || [ -L "$recorded_dir/Delve.app" ]; then
    leave "$recorded_dir/Delve.app (installed without a file list). Move it to Trash to uninstall."
    return
  fi
  if [ "$uninstall_pending" = yes ]; then
    leave "$mac_location (kept to retry uninstall)"
  else
    remove_entry "$mac_location" f
    remove_entry "$share" d
  fi
  report_uninstall "$recorded_dir/Delve.app"
}

uninstall() {
  ensure_stopped
  uninstall_pending=no
  case $(uname -s) in
    Linux) uninstall_linux ;;
    Darwin) uninstall_mac ;;
    *) die "This platform is unsupported, not supported yet. See $releases" ;;
  esac
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
valid_version "$version" || die 'Invalid release version.'
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
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum < "$1") || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 < "$1") || return 1
  else
    die 'sha256sum or shasum is required.'
  fi
  printf '%s\n' "${digest%% *}"
}
actual=$(checksum "$tmp/$asset") || die "Could not read checksum for $asset."
[ "$actual" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ] || die "Checksum mismatch for $asset; installation aborted."
printf 'Checksum verified.\n'

check_file_destination() {
  if [ -L "$1" ] || { [ -e "$1" ] && [ ! -f "$1" ]; }; then
    die "$1 is not a regular file. Please move it first."
  fi
}

report_install() {
  if [ "$previous_version" = "$version" ]; then
    printf 'Delve v%s is already installed: reinstalled\n' "$version"
  elif [ -n "$previous_version" ]; then
    printf 'Updated v%s → v%s\n' "$previous_version" "$version"
  elif [ "$replacing" = yes ]; then
    printf 'Updated existing Delve installation to v%s\n' "$version"
  else
    printf 'Installed Delve v%s to %s\n' "$version" "$1"
  fi
}

write_linux_launchers() {
  cat > "$tmp/launch" <<'LAUNCH'
#!/bin/sh
printf 'Starting Delve...\n'
# The AppImage runtime lists extracted paths on stdout and reports errors on stderr.
exec "$HOME/.local/share/delve/Delve.AppImage" --appimage-extract-and-run "$@" >/dev/null
LAUNCH
  chmod +x "$tmp/launch"
  escaped=$(printf '%s' "$launcher" | sed 's/[\\"`$]/\\&/g')
  cat > "$tmp/delve.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Delve
Exec="$escaped" %U
Icon=delve
Categories=Education;
Terminal=false
MimeType=x-scheme-handler/delve;
DESKTOP
}

linux_next() {
  printf 'Next:\n'
  case :$PATH: in
    *:"${bin%/*}":*|*:"${bin%/*}/":*) printf '  Open Delve from your app menu or run delve.\n'; return ;;
  esac
  printf '  Open Delve from your app menu, or set up the delve command:\n'
  path_export="    export PATH=\"\$HOME/.local/bin:\$PATH\""
  fish_path="    fish_add_path \"\$HOME/.local/bin\""
  case ${SHELL:-} in
    bash|*/bash) printf '  Add to ~/.bashrc:\n%s\n' "$path_export" ;;
    zsh|*/zsh) printf '  Add to ~/.zshrc:\n%s\n' "$path_export" ;;
    fish|*/fish) printf '  Add to ~/.config/fish/config.fish:\n%s\n' "$fish_path" ;;
    *) printf '  For bash or zsh, add to ~/.bashrc or ~/.zshrc:\n%s\n' "$path_export"
       printf '  For fish, add to ~/.config/fish/config.fish:\n%s\n' "$fish_path" ;;
  esac
  printf '  Open a new terminal, then run delve.\n'
}

install_linux() {
  for dir in "$share" "${bin%/*}" "${desktop%/*}" "${icon%/*}"; do
    safe_directory "$dir" || die "$dir contains a symlink or is not a directory."
  done
  replacing=no
  if linux_installation_present; then replacing=yes; fi
  for path in "$appimage" "$launcher" "$desktop" "$icon" "$version_file"; do
    check_file_destination "$path"
    if [ "$replacing" = no ] && [ -e "$path" ]; then die "$path already exists. Please move it first."; fi
  done
  if [ -e "$bin" ] || [ -L "$bin" ]; then
    installed_bin || die "$bin already exists. Please move it first."
  fi
  previous_version=
  if [ -f "$appimage" ]; then
    if [ -f "$version_file" ]; then
      IFS= read -r previous_version < "$version_file" || die 'Invalid installed version.'
      valid_version "$previous_version" || die 'Invalid installed version.'
    else
      legacy_digest=$(checksum "$appimage") || die "Could not verify $appimage."
      if [ "$legacy_digest" = "$actual" ]; then previous_version=$version; fi
    fi
  fi

  printf 'Preparing the AppImage and desktop launcher...\n'
  chmod +x "$tmp/$asset"
  (cd "$tmp" && "./$asset" --appimage-extract >/dev/null) || die 'Could not extract the app icon.'
  find "$tmp/squashfs-root" -type f -name '*.png' -print > "$tmp/icons" || die 'Could not find the app icon.'
  IFS= read -r source_icon < "$tmp/icons" || die 'AppImage has no PNG icon.'
  write_linux_launchers
  mkdir -p "$share" "${bin%/*}" "${desktop%/*}" "${icon%/*}"
  stage=$(mktemp -d "$share/.install.XXXXXXXX") || die 'Could not stage the AppImage.'
  mv "$tmp/$asset" "$stage/Delve.AppImage"
  printf '%s\n' "$version" > "$stage/version"
  mv -f "$tmp/launch" "$launcher"
  mv -f "$stage/Delve.AppImage" "$appimage"
  mv -f "$source_icon" "$icon"
  mv -f "$tmp/delve.desktop" "$desktop"
  if ! installed_bin; then ln -s "$launcher" "$bin"; fi
  mv -f "$stage/version" "$version_file"
  report_install "$appimage"
  linux_next
}
bundle_manifest() (
  cd "$1" || exit 1
  [ ! -L Delve.app ] && [ -d Delve.app ] || exit 1
  find Delve.app -depth -exec sh -eu -c '
    tab=$(printf "\t")
    newline="
"
    for entry do
      case $entry in *"$tab"*|*"$newline"*) exit 1 ;; esac
      if [ -L "$entry" ]; then
        type=l
      elif [ -d "$entry" ]; then
        type=d
      elif [ -f "$entry" ]; then
        type=f
      else
        exit 1
      fi
      printf "%s\t%s\n" "$type" "$entry"
    done
  ' sh {} +
)

prepare_mac_destination() {
  app_dir=${DELVE_INSTALL_DIR:-/Applications}
  case $app_dir in /Applications|"$HOME/Applications") ;; *) die 'DELVE_INSTALL_DIR must be /Applications or ~/Applications.' ;; esac
  safe_directory "$share" || die "$share contains a symlink or is not a directory."
  check_file_destination "$mac_location"
  recorded_dir=
  recorded_version=
  if [ -f "$mac_location" ]; then
    read_mac_receipt
    safe_directory "$recorded_dir" || die "$recorded_dir contains a symlink or is not a directory."
    if [ -z "${DELVE_INSTALL_DIR:-}" ]; then app_dir=$recorded_dir; fi
  fi
  if [ "$app_dir" = /Applications ] && [ ! -w "$app_dir" ]; then app_dir=$HOME/Applications; fi
  safe_directory "$app_dir" || die "$app_dir contains a symlink or is not a directory."
  if [ -n "$recorded_dir" ] && [ "$recorded_dir" != "$app_dir" ]; then
    if [ -e "$recorded_dir/Delve.app" ] || [ -L "$recorded_dir/Delve.app" ]; then
      die "Delve is already installed at $recorded_dir/Delve.app. Uninstall it before changing locations."
    fi
  fi
  mac_app=$app_dir/Delve.app
  if [ -L "$mac_app" ] || { [ -e "$mac_app" ] && { [ ! -d "$mac_app" ] || [ "$recorded_dir" != "$app_dir" ]; }; }; then
    die "$mac_app already exists. Please move it first."
  fi
}

check_mac_replacement() {
  replacing=no
  previous_version=
  if [ ! -d "$mac_app" ]; then return; fi
  replacing=yes
  expected_manifest=$tmp/mac-install-files
  if [ -n "$recorded_version" ]; then
    sed '1,2d' "$mac_location" > "$tmp/previous-files"
    expected_manifest=$tmp/previous-files
  fi
  bundle_manifest "$app_dir" > "$tmp/existing-files" || die "Could not list files in $mac_app."
  LC_ALL=C sort "$tmp/existing-files" > "$tmp/existing-sorted"
  LC_ALL=C sort "$expected_manifest" > "$tmp/expected-sorted"
  cmp -s "$tmp/existing-sorted" "$tmp/expected-sorted" ||
    die "$mac_app differs from the installer file list. Move it first to keep its contents."
  previous_version=$recorded_version
  plist=$mac_app/Contents/Info.plist
  if [ -z "$previous_version" ] && safe_directory "${plist%/*}" && [ ! -L "$plist" ] && [ -f "$plist" ]; then
    if plist_version=$(plutil -extract CFBundleShortVersionString raw -o - "$plist") &&
      valid_version "$plist_version"; then
      previous_version=$plist_version
    fi
  fi
}

install_mac() {
  prepare_mac_destination
  printf 'Preparing the macOS application...\n'
  mkdir -p "$app_dir" "$share"
  stage=$(mktemp -d "$app_dir/.delve-install.XXXXXXXX") || die 'Could not stage Delve.app.'
  mount=$tmp/mount
  mkdir "$mount"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$tmp/$asset" >/dev/null || { mount=; die 'Could not mount the disk image.'; }
  [ -d "$mount/Delve.app" ] || die 'Disk image does not contain Delve.app.'
  ditto "$mount/Delve.app" "$stage/Delve.app" || die 'Could not copy Delve.app.'
  hdiutil detach "$mount" >/dev/null || die 'Could not detach the disk image.'
  mount=
  if ! xattr -dr com.apple.quarantine "$stage/Delve.app" 2>/dev/null; then
    attributes=$(xattr -lr "$stage/Delve.app") || die 'Could not inspect app attributes.'
    case $attributes in *com.apple.quarantine*) die 'Could not remove quarantine from Delve.app.' ;; esac
  fi
  bundle_manifest "$stage" > "$tmp/mac-install-files" || die 'Could not list Delve.app files.'
  check_mac_replacement
  pending_receipt=$(mktemp "$share/.receipt.XXXXXXXX") || die 'Could not stage the macOS installation record.'
  {
    printf '%s\n' "$app_dir" "$version"
    cat "$tmp/mac-install-files"
  } > "$pending_receipt"
  if [ "$replacing" = yes ]; then
    backup=$stage/previous.app
    mv "$mac_app" "$backup" || die 'Could not replace Delve.app.'
  fi
  mv "$stage/Delve.app" "$mac_app" || die 'Could not install Delve.app.'
  if ! mv -f "$pending_receipt" "$mac_location"; then
    mv "$mac_app" "$stage/Delve.app" || die "Could not remove the incomplete installation at $mac_app."
    die 'Could not save the macOS installation record.'
  fi
  pending_receipt=
  backup=
  report_install "$mac_app"
  printf 'Next:\n  Open Delve from %s in Finder.\n' "$app_dir"
}
case $platform in linux) install_linux ;; mac) install_mac ;; esac
