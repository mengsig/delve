# Delve

Learn the codebase your agents are building. A local-first, open-source desktop app (Electron) that keeps developers in touch with a repository: learn it from scratch, then follow what changed and why, at three depths.

Status: early development. This is the foundation: the hardened desktop shell, the local knowledge
graph, the provider runner and a minimal workspace page. The Contour interface comes next.

- Product direction: [`docs/product.md`](docs/product.md)
- Binding requirements (R1–R17): [`docs/requirements.md`](docs/requirements.md)
- Approved design: [`docs/design/proposal-v1.html`](docs/design/proposal-v1.html) (open in a browser)

## Install

Download a package for your platform from the CI artifacts or a release: an AppImage or `.deb` for
Linux, a `.dmg` for macOS, or an NSIS installer for Windows. Packages are not yet code-signed.

To generate lessons, Delve uses a CLI you already have and are signed in to:
[Claude Code](https://code.claude.com/docs/en/headless) (`claude`) or
[Codex](https://developers.openai.com/codex/noninteractive/) (`codex`). Delve never calls a paid API
itself and never copies your credentials. If neither CLI is on your `PATH`, Delve shows "not found".

## Develop

Requirements: Node.js 24 (22.13 or later works) and npm. The project uses **npm**; commit
`package-lock.json` changes.

```sh
npm ci            # install dependencies (downloads Electron)
npm run dev       # start the app with hot reload
```

| Script | What it does |
| --- | --- |
| `npm run lint` | ESLint over the whole project |
| `npm run typecheck` | TypeScript for main/preload and for the renderer |
| `npm test` | Vitest unit tests (database, IPC, security guards, provider runner with a fake CLI) |
| `npm run test:smoke` | Builds, then launches the app with Playwright and drives the workspace page |
| `npm run build` | Builds main, preload and renderer into `out/` |
| `npm run package` | Builds installers for the current platform into `release/` |
| `npm run package:linux` / `:mac` / `:win` | Builds AppImage + deb, dmg, or NSIS |

The smoke test needs a display. On Linux CI it runs under Xvfb:
`xvfb-run --auto-servernum -- npm run test:smoke`.

Delve stores its database (`delve.sqlite`) in Electron's user data directory. Set
`DELVE_USER_DATA_DIR=/some/dir` to use another one, as the smoke test does.

## Layout

```
src/shared/      types and the typed IPC channel map shared by every process
src/main/        Electron main: window, security policy, app:// protocol, IPC handlers
src/main/db/     node:sqlite database, versioned migrations, knowledge-graph domain functions
src/main/providers/  claude/codex detection and the sandboxed CLI runner
src/preload/     the only bridge: a typed `window.delve.invoke`
src/renderer/    React UI (Vite)
tests/smoke/     Playwright smoke test of the built app
```

## Security model

The renderer is sandboxed and context-isolated, without Node integration, and loads only from the
`app://delve` origin with a strict Content Security Policy. Navigation, new windows, webviews and
permission requests are refused. Main validates every IPC request and ignores frames from other
origins. Packaged builds disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and inspector flags via
Electron fuses. Provider CLIs run with fixed arguments, no shell, no write tools or project plugins, in an empty
temporary directory, and without API-key environment variables.

## License

[MIT](LICENSE)
