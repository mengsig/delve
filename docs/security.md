# Dependency audit

`npm audit` on 2026-11-21 reports six moderate dependency findings rooted in [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), a denial of service from attacker-controlled glob patterns in minimatch. The affected packages are minimatch, @electron/universal, app-builder-lib, dmg-builder, electron-builder-squirrel-windows, and electron-builder. They are build-time dependencies; installer builds use patterns from this repository's configuration, not untrusted user input, and these packages are not shipped as application runtime dependencies. Revisit when electron-builder updates its minimatch dependencies. Do not build untrusted changes with privileged credentials.

Electron was upgraded to 44.11.5 to address its reported advisories, including the high-severity certificate advisory. Run `npm audit` again when updating dependencies: this assessment applies to the lockfile at release preparation time.
