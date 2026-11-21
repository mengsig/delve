# Linux installation notes

The AppImage needs FUSE 2 (`libfuse2` on Debian/Ubuntu, or the equivalent for your distribution). If FUSE is unavailable, run `./Delve-*.AppImage --appimage-extract` and start `./squashfs-root/AppRun`. Keep the extracted directory together.

Delve chooses Wayland when a Wayland session is available and otherwise uses X11. Run it inside a graphical session with a working `WAYLAND_DISPLAY` or `DISPLAY`. If a desktop launcher does not inherit the session environment, launch it from a terminal in that session.
If X11 is reachable only through an abstract socket without `/tmp/.X11-unix`, launch with `--ozone-platform=x11` to override display detection.

The Debian package installs `delve.desktop` with the `delve://` MIME handler. To select it as the default handler, run:

```sh
xdg-mime default delve.desktop x-scheme-handler/delve
```

A standalone AppImage is not installed into the desktop menu automatically. Put it at `~/Applications/Delve.AppImage`, make it executable, and run the following once to install its desktop entry and select the handler:

```sh
mkdir -p ~/.local/share/applications
printf '[Desktop Entry]\nType=Application\nName=Delve\nExec=%s/Applications/Delve.AppImage %%U\nTerminal=false\nMimeType=x-scheme-handler/delve;\nCategories=Education;\n' "$HOME" > ~/.local/share/applications/delve-appimage.desktop
xdg-mime default delve-appimage.desktop x-scheme-handler/delve
```

This example assumes the home directory path contains no spaces or desktop-entry special characters. For other paths, create a desktop entry with a correctly quoted `Exec` value following the desktop-entry specification. Verify the choice with `xdg-mime query default x-scheme-handler/delve`.
