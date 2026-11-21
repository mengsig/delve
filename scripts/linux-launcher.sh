#!/bin/sh
set -eu

executable=$(command -p readlink -f -- "$0").bin

# Electron reads Ozone switches before loading the application's main script.
for arg do
  case "$arg" in
    --ozone-platform|--ozone-platform=*|--x11-display|--x11-display=*)
      exec "$executable" "$@"
      ;;
    --) break ;;
  esac
done

wayland_display=${WAYLAND_DISPLAY-wayland-0}
case "$wayland_display" in
  /*) wayland_socket=$wayland_display ;;
  '') wayland_socket= ;;
  *) wayland_socket=${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/$wayland_display} ;;
esac

case "${DISPLAY:-}" in
  :[0-9]*|unix:[0-9]*)
    display_number=${DISPLAY#*:}
    display_number=${display_number%%.*}
    case "$display_number" in
      *[!0-9]*|'') ;;
      *) if [ ! -S "/tmp/.X11-unix/X$display_number" ]; then DISPLAY=; fi ;;
    esac
    ;;
esac
if [ -n "${WAYLAND_SOCKET:-}" ] || [ -S "$wayland_socket" ]; then
  if [ -z "${DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" != x11 ]; then
    exec "$executable" --ozone-platform=wayland "$@"
  fi
fi
if [ -n "${DISPLAY:-}" ]; then
  exec "$executable" --ozone-platform=x11 "$@"
fi

printf '%s\n' 'Delve requires a graphical session. Launch from a desktop or pass its Wayland (XDG_RUNTIME_DIR and WAYLAND_DISPLAY) or X11 (DISPLAY) environment.' >&2
exit 1
