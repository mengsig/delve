# Delve environment protocol

A lesson can contain multiple environment blocks. One instrument runs at a time in the conversation.
The stored block selects a versioned pack or includes a content-addressed program. Delve resolves a
`delve.env/1` manifest with a typed configuration, JSON event schema, rubric ID and text alternative.
The pack version fixes the schema and rubric. A lesson cannot supply executable grading code.

A repository lesson might contain this block.

```json
{
  "type": "environment",
  "runtime": "delve.env/1",
  "pack": "lease-handoff@1",
  "config": {
    "pack": "lease-handoff@1",
    "parameters": { "taskId": "042", "initialGeneration": 7, "deadlineTicks": 3 }
  },
  "fallback": "After three ticks, B holds generation 8. A offers generation 7. Compare before committing."
}
```

Saved pack references without explicit parameters use the version's defaults.

| Pack | Allowed actions | Host rubric |
| --- | --- | --- |
| `lease-handoff@1` | Advance one tick, accept or reject at expiry, reset | `compare-generation@1` checks the write decision against the active generation. |
| `camera-exposure@1` | Set shutter or ISO, capture, reset | `motion-and-brightness@1` checks motion trails and the exposure ratio at capture. |
| `network-builder@1` | Connect or disconnect two configured ports, test path, reset | `route-through-proxy@1` reconstructs both hops of the simulated route. |

An already-solved starting configuration is a worked example. Capturing it or testing its route records a
practice observation without changing the learner’s evidence. Demonstrating the goal requires changing
a camera setting or adding a hop. Reset clears the record of those choices.

The provider may choose a built-in config or return a new `bundle@1` with API version `delve.view/1`.
The bundle carries UTF-8 source, the fixed entry point `step`, a title and an initial parameter string.
Delve computes the SHA-256 digest at ingestion and verifies it against the saved bytes at launch.
There is no dependency loader. A program defines `step(initial, action)` and keeps its own private
state across calls. The first action is an empty string. Later actions must match a currently offered
control ID. Each view contains the following fields.

| Field | Shape |
| --- | --- |
| `text` | A description of the current state, 1–1,500 characters. |
| `controls` | Up to 32 distinct buttons with an `id` matching `[a-z][a-z0-9_-]{0,31}` and a text `label`. |
| `marks` | Up to 256 rectangles with numeric `x`, `y`, `width`, `height` in the range 0–100 and a six-digit hex `color`. |

## Threat model

Treat lessons, parameters, program bytes and guest output as untrusted. The isolated stage is a
sandboxed opaque-origin iframe. It loads a fixed local script and stylesheet from a dedicated origin.
Its CSP denies connections and other resources. Electron denies permissions, downloads and document
navigation. If Chromium replaces the frame with an inert document, Delve closes the stage.

The stage contains trusted display code. Generated JavaScript executes inside a QuickJS WebAssembly
runtime in a disposable browser worker created by the opaque frame. Its bootstrap checks the opaque origin before loading code. It receives only its initial parameter and a selected control
ID. It has no browser DOM, parent, network, filesystem, storage, Node, preload, Electron IPC, main
process, secrets or workspace access. Display labels become text nodes and drawing instructions
become bounded canvas marks. The runtime has no callbacks into the desktop. A new instrument starts
with fresh memory.

Delve bounds the VM heap to 2 MiB and the stack to 128 KiB. Each evaluation gets up to 64 interpreter
interrupt intervals or 100 ms. An independent watchdog terminates the worker after 3 seconds at
startup or 500 ms per action. Each view is limited to 32 KiB of UTF-8 JSON. The shipped declarative
reducers execute a bounded transition per accepted action over fixed-size state. The largest topology
has four ports and two links. A session ends after 15 minutes or 256 actions. The private frame port
caps packets at 1,024 UTF-16 units, 48 messages per second and 256 KiB over the session. A budget failure
removes the live stage and opens its text alternative.

Only the top-level Delve renderer has a preload bridge. Main validates the active workspace, lesson
revision, originating snapshot of a saved tutor instrument, message and block address at launch and on pack actions. The host verifies the sending
port, session, sequence, action bounds, rate and state before accepting observations. The database
transaction records a rubric result and a short field note together. A portable record in another
workspace retains its origin. The tutor can receive the summary through the existing provider consent
flow. Raw keystrokes, pointer trajectories and custom-program state are never sent as observations.
Custom views use the `practice-only@1` rubric and cannot write evidence.

Kernel and Chromium zero-days, and a user deliberately executing untrusted native software outside
Delve, are outside this model.
