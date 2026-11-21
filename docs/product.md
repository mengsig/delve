# Delve: product direction

Delve is a learning companion for developers whose code is increasingly written by agents. It keeps
you in touch with a codebase: learn a repository from scratch, then keep up with every PR and commit,
and learn any other topic the same way.

The approved visual and interaction design is `docs/design/proposal-v1.html` (open it in a browser).
Numbered requirements are in `docs/requirements.md`; every change must keep them true.

## Principles
- Desktop app (Electron), open source, local-first, single user. Downloadable by others.
- Agents run on the user's own installed Claude Code (`claude -p`) or Codex (`codex exec`) CLI and
  subscription. Delve never silently falls back to API billing.
- A knowledge graph of concepts with prerequisites. A concept learned once at a depth is never taught
  again (learn nginx once; reuse it in every repository that uses nginx).
- Three depths: High (what and why; CTO), Medium (adds how, at module level; lead), Low (protocol and
  code detail; implementer or reviewer). Medium is the default.
- Learning is a conversation. The tutor teaches (explains, gives analogies, worked examples,
  diagrams and simulations) and answers questions at any time; checks are optional and come after
  teaching. The agent observes how the learner does, diagnoses weak areas and adapts the path.
- Lessons are typed data (`delve.lesson/1` blocks) that Delve renders; agents never write whole pages.
  Interactive environments use an open manifest (`delve.env/1`) and run sandboxed.
- Game feel without game mechanics: no quests, XP, levels, streaks, timers or ranks.
- Independent of Archon and Aether, with a seam for later integration (`delve://learn` intents).
