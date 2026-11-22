# Delve requirements

Numbered and binding. A change that touches one keeps it true; none is deferred without the
maintainer's approval. Design reference: `docs/design/proposal-v1.html`.

- **R1 Desktop shell.** Electron + TypeScript; React/Vite renderer; no production web server.
  Hardened: contextIsolation, sandboxed renderer, no nodeIntegration, narrow typed preload IPC, CSP.
  Builds installable packages for Linux, macOS and Windows.
- **R2 Contour design.** The Contour surface from the design reference, in light and dark themes, with
  its motion and typography; Folio offered as the accessible relationship-list view at every scale.
  Apple/Tesla-quality polish: smooth animations, keyboard access, reduced-motion support.
- **R3 Workspaces.** Add several workspaces (a local Git repository, a GitHub repository, or a
  non-code topic) and switch between them fast (switcher with keyboard shortcut).
- **R4 Knowledge graph.** One local SQLite database owned by the main process: workspaces, canonical
  concepts, prerequisite edges, snapshot bindings, validated lessons, per-depth evidence. Portable
  concepts are shared across workspaces; a concept known at a depth is reused, never retaught.
- **R5 Depths.** High / Medium / Low as defined in `docs/product.md`; default Medium; switching depth
  keeps the same concept; reuse requires an exact portable concept at a demonstrated depth.
- **R6 Lesson blocks.** Agents emit versioned JSON (`delve.lesson/1`) of typed blocks (prose, diagram,
  code with spans, trace, check, environment, ...). Delve validates and renders them. Invalid lesson:
  keep the last valid version and offer retry; unknown block types degrade visibly.
- **R7 Chat-first learning.** Each lesson is a conversation with the tutor: the learner can ask
  anything at any time; the tutor teaches first (explanation, analogy, worked example, visual), asks
  questions to check understanding, and responds to answers. Blocks render inline in the conversation.
  Teaching, not only quizzing.
- **R8 Agentic adaptation.** The agent observes answers and environment actions, diagnoses weak
  areas, and adapts: re-explains differently, generates a new visualization or simulation, changes the
  suggested path. Every recommendation shows its reason.
- **R9 Environments.** `delve.env/1` manifest; declarative packs first; run in an opaque-origin
  sandbox with no Node, IPC, network, navigation or secrets; the host validates events and awards
  evidence (generated code cannot). CPU, time, output and memory limits are enforced outside the guest.
  Ship at least one repository-focused environment and one non-code environment.
- **R10 Repository baseline.** Read a local Git snapshot without running hooks or project code, build
  the concept map for the repository, and offer a first learning path.
- **R11 Changes.** For a PR or commit, "what changed and why" at the chosen depth, linked to the
  concepts it touches. PR metadata and diffs come via read-only GitHub access (the user's `gh` login
  or a token in the OS keychain). Missing or truncated diffs show partial coverage.
- **R12 Recommendations.** The agent recommends the next step from the learner's knowledge graph
  (for example "explain this feature" versus "what changed and why"), with the reason shown.
- **R13 Evidence and privacy.** At most one optional practical check per lesson, stored locally as
  revisable evidence; reset available; only useful actions are tracked; no points, XP, streaks, timers
  or ranks; peer comparison off by default.
- **R14 Providers.** Use the installed, signed-in `codex exec` or `claude -p` with fixed argv, no
  shell, a clean working directory, no write tools or project plugins; credentials are never copied.
  Detect and show sign-in state. Preview the files and estimated size before sending. Generate only the
  chosen depth. Cache by commit/diff, concept, depth, schema and model. De-duplicate in-flight work,
  allow cancel, bound retries, stop on quota.
- **R15 Any topic.** Workspaces, concepts, evidence and environments are topic-neutral; a non-code
  topic (for example chess or network building) works end to end.
- **R16 Integration seam.** Optional `delve://learn` intents carrying a repository and a commit, PR or
  proposed-work reference; Delve previews provenance and asks before importing. Works without
  Archon or Aether.
- **R17 Open source.** MIT licence, README with install and development instructions, tests and CI
  (lint, typecheck, unit tests, a smoke test that launches the app).
- **R18 Changes explorer.** Open a commit or pull request in one click from a searchable,
  paged branch timeline. Show parent and merge relationships, branch, PR and author filters,
  virtualized rows and a keyboard-accessible Folio list. Show the change's state, author,
  branches, dates and size alongside Explanation, Files changed and Concepts tabs. Link reviewed
  diff spans to concepts and open them on the Atlas. View change-only concepts there temporarily. Open the change lesson in one click,
  retaining R14 source approval for new generation. Accepted learn links select the referenced
  change. Make missing patches, unavailable GitHub access and empty histories explicit.
- **R19 Global knowledge graph.** Knowledge is a one-click global destination across topic and
  repository workspaces. Show each canonical concept once, its workspace memberships and shared
  bridges, prerequisite and transfer links, and its mastery state and depth. Search, filter by
  workspace, state and depth, focus a neighbourhood, and preserve filters and map position. Offer a
  virtualized, recent-first list of understood concepts, grouped by workspace or flat, with dates,
  depths and transfers. In the learned list, Tab reaches each concept and lesson action; Arrow Up,
  Arrow Down, Home and End move between rows and scroll the focused row into view. Preserve the
  current concept's position when grouping or filtering. A concept's detail provides its summary, relationships, workspaces and
  one-click lesson, review and Atlas actions. A learner may preview and explicitly approve an
  on-demand model request for transfer suggestions, inspect their reasons and provenance, and remove
  incorrect links. Keep data local and validate links and model output. Support light and dark themes,
  keyboard access and the minimum desktop window; keep large graphs responsive. Demo fixtures do not
  count as personal learning. The desktop performance test budgets 5 seconds to load and paint and
  1 second to pan at 2,000 concepts and 5,000 edges; the local query is budgeted at 500 ms.
