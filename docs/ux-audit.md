# Learning journeys

## Baseline

The audit started on `cad80b3` with the packaged Linux desktop under Xvfb, a fresh local profile, a 1280 × 800 content area and a signed-in fixture CLI. “Home” means Atlas for a returning learner and the source form on first launch. A click, Enter to submit, or a shortcut counts as one action. Typing the requested subject, pasting a source and dropping a folder count as input. Waiting for a result adds no actions. Optional inspection and changes to defaults are counted separately.

| Journey | Before | Friction |
| --- | --- | --- |
| Atlas → first block of a new topic | 6 clicks plus input | Add → Any topic → Add to atlas → Start a topic lesson → Start lesson → Allow and continue. Medium is already the default. |
| First launch → first topic block | 5 clicks plus input | Setup, an empty atlas and an empty reader all ask the learner to start. |
| Atlas → repository map | 2 clicks plus paste/drop | Add → Add and build map. The form reserves space for source, depth and provider before the review. The map can refresh in place. |
| Changes → PR or commit page | 1 click | The timeline already supports direct selection. |
| PR page → lesson | 2 fresh, 1 saved | Teach me this change opens a second review for a fresh request. A saved lesson opens immediately. |
| Switch workspace | 2 clicks | Open the switcher, then choose the destination. |
| Atlas, Changes, Progress | 1 click each | The header works across views. The keyboard switcher only searches workspaces. |
| Last lesson, environment or change | No direct action | Re-select the workspace and find the concept, instrument or change again. The active workspace survives restart. |
| Tutor/source consent and preview | 1 approval after opening review | The exact payload is available, but there is no explicit durable choice for this workspace. |
| Tutor follow-up, interactive lab and progress | Type + submit; Jump to instrument in 1; Progress in 1 | New replies can move the page while reading earlier material. Long tutor work is tied to the reader. |
| Incoming learn link | 1 approval to open | Keep workspace and source visible before importing. |

## Earlier previews

Preview 2 found a rejected hard-coded Codex model and terrain clicks intercepted over Durable queue. Preview 2.5 verified model selection and terrain clicks, but the sticky tutor composer intercepted instrument controls. Preview 3 ran the packaged app after those fixes. It confirmed direct terrain selection, pointer access to the labs, exact reviewed source payloads, single-click timeline navigation and separate first-time change approval. Its live-provider check lacked a dedicated subscription. The deterministic provider exercises the desktop's normal CLI boundary without using personal credentials.
