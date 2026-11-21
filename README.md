# Delve

Learn the codebase your agents are building. A local-first, open-source desktop app (Electron) that keeps developers in touch with a repository: learn it from scratch, then follow what changed and why, at three depths.

Open the Atlas to explore prerequisites on a terrain map or switch to the Folio relationship list.
On first launch, choose a local repository, GitHub repository or topic, your starting depth and a
signed-in CLI. **Explore demo atlas** opens the offline Archon, Relay and Photography workspaces.
Use **+ Add** for more workspaces.
Progress shows the evidence behind each reading depth and where to reset a shared record.

Open a concept at High, Medium or Low depth to read its lesson and ask the tutor a question.
In an empty topic atlas, choose **Start a topic lesson**. Before the first live request, review
the prompt, model and byte count. The tutor receives concept summaries, selected-depth evidence
and recent conversation from the local graph. No repository files are attached. You can preview
individual questions, cancel a turn and retry. The optional check updates local evidence, and the
tutor explains its next suggestion. Reset a check in **Progress** at its recorded workspace.

## Learn a repository

Choose a local Git working tree or enter a GitHub URL or `owner/name`. Delve reads the selected
commit from the object database. GitHub workspaces use a shallow bare clone of the default branch
in Delve’s user data directory. Install Git and use `gh auth login` for private repositories and
pull requests. Delve uses read-only operations with that login.

Select the files to include and review their names, sizes, revision and exact provider request.
**Approve and map** generates concepts, prerequisites and a suggested first step at the selected
depth. Demonstrated portable concepts carry their evidence across repositories. You can add another
slice from the Atlas. Each slice contains at most 128 text files, 128 KiB per file and 1 MiB total.

In **Changes**, choose a recent commit or pull request and preview its diff before approving a brief.
GitHub workspaces and local repositories with a GitHub origin list pull requests. Local commit briefs
compare against the first parent. The footprint links to the affected concepts and the brief opens
as a tutor conversation. A partial coverage notice identifies missing or omitted diff material.
Saved briefs remain available offline. **Refresh diff preview** checks for an updated revision.

Installed packages accept learn links such as
`delve://learn?workspace=octo/site&pr=184`. Use an existing repository workspace UUID or a GitHub
`owner/name` and exactly one of `pr`, `commit` (a hexadecimal Git ID), or `proposed` (a reference
to discuss). Delve displays the incoming workspace and reference for approval. Opening a repository
or preparing a request requires a separate decision from sending material to the provider.

The demo tutor runs entirely offline. The Archon demo includes an illustrative brief for PR #184.

- Product direction: [`docs/product.md`](docs/product.md)
- Binding requirements (R1–R17): [`docs/requirements.md`](docs/requirements.md)
- Approved design: [`docs/design/proposal-v1.html`](docs/design/proposal-v1.html) (open in a browser)

## Interactive lessons

Open **Worker leases** in Archon or **Moving subjects** in Photography. Advance the lease clock and decide
whether to accept the late write, or change shutter speed and ISO and capture the rider. The observation
appears in the conversation, with a reason for the next exercise. **Progress** shows the evidence and
its originating workspace. Each lab has a keyboard interface and a text alternative.

The tutor can insert instruments into an opening lesson or a later message. A network instrument lets
you wire simulated ports by dragging or by selecting an output followed by an input. For a custom
topic, the tutor can also supply a self-contained program with its own state, drawing and controls.
Custom programs run as practice. Host-verifiable rubrics currently ship for the dispatch, exposure
and network instruments. See the [environment protocol](docs/environments.md).

## Install

Download a package for your platform from the CI artifacts or a release: an AppImage or `.deb` for
Linux, a `.dmg` for macOS, or an NSIS installer for Windows. Packages are not yet code-signed.

To generate lessons, Delve uses a CLI you already have and are signed in to:
[Claude Code](https://code.claude.com/docs/en/headless) (`claude`) or
[Codex](https://developers.openai.com/codex/noninteractive/) (`codex`). Delve never calls a paid API
itself and never copies your credentials. It only runs a CLI signed in with a subscription
(claude.ai or ChatGPT); a CLI signed in with an API key is shown and refused, because it bills per
use. If neither CLI is on your `PATH`, Delve shows "not found".
Live tutor requests use `gpt-5.4` or `claude-sonnet-4-6`. Set `DELVE_CODEX_MODEL` or
`DELVE_CLAUDE_MODEL` before launching to use another model available to your subscription.

Ctrl+K (⌘K on macOS) or the "Switch workspace" button opens the workspace switcher: type to filter,
use the arrow keys, press Enter to switch and Escape to close.

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
| `npm run test:providers` | Only the provider runner tests; CI runs them on Linux, macOS and Windows |
| `npm run test:smoke` | Builds, then launches the app with Playwright and drives workspace, graph and evidence flows |
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
temporary directory, and without API-key environment variables. Delve runs a CLI only when it is
signed in with a subscription; an API key, including one the CLI has stored, is reported as "not
signed in with a subscription". On Linux and macOS each CLI runs in its own process group: timeout
or cancellation sends the group SIGTERM, then SIGKILL after a grace period. On Windows,
`taskkill /T /F` stops the tree on timeout or cancellation. Either way a signal is sent only while
the CLI has not exited, so it cannot reach a reused process id (on Windows the CLI may still exit
while taskkill starts). A run settles when the CLI exits, without waiting on pipes a descendant
still holds. Limits: descendants that outlive the CLI's exit are not stopped, and one that leaves
the process group or session is out of scope (claude and codex do neither). Output is capped at
8 MiB, including Codex's final-message file. npm `.cmd` launchers on Windows are run through Node directly, never
through a shell.

## License

[MIT](LICENSE)
