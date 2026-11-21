# Learning journeys

The audit began on `cad80b3` with the packaged Linux desktop under Xvfb, a fresh profile, a 1280 × 800 content area and a signed-in fixture CLI. The returning home screen is Atlas. First launch opens the source form. Both versions used the same local Git, PR and tutor fixtures. The Contour and Folio design, reading depths and local learning record carry through these changes.

A click, Enter to submit or a keyboard shortcut counts as one action. Typing the requested title, pasting a source or dropping a folder counts as input. Waiting is free. Optional preview, depth or permission changes are measured separately. The smoke suite counts trusted input events from the first action through the asserted destination, including fresh first-use approval.

## Action budgets

| Learner journey | Before | After | Friction and change |
| --- | ---: | ---: | --- |
| Atlas → first visible block of a new topic | 6 + input | **2 + input** | Previously Add → Any topic → Add to atlas → Start a topic lesson → Start lesson → approve. Now + Add focuses the field, and approving opens the lesson. Medium is the default. |
| First launch → first topic block | 5 + input | **1 + input** | Type into the focused field and start with either permission choice. Change depth in the reader. |
| Atlas → concept map from a GitHub URL | 2 + input | **2 + input** | + Add, paste, approve the map. Source inspection and file editing share the page. The Atlas fills in while the learner stays there. |
| Source form → map from a local path or dropped folder | 1 after input | **1 after input** | Drop or paste, then Add and build map. The signed-in tutor receives the reviewed snapshot. Progress appears immediately. A failed inventory offers retry. |
| Changes timeline → PR or commit page | 1 | **1** | Select a row to see the change. Arrow keys, Enter and Escape also work. |
| PR or commit page → first change lesson | 2 | **1** | Previously Teach opened a separate approval. The page now prepares the diff for inspection. Teach approves it and opens the lesson. |
| PR page → saved lesson | 1 | **1** | Reopen the cached lesson, including offline. |
| Atlas → another workspace | 2 | **1** | Direct workspace buttons replace opening a picker first. The full list remains searchable. |
| Go to Atlas, Changes or Progress | 1 | **1 each** | Persistent header actions also keep the selected change when returning to Changes. |
| Command palette | Shortcut, type, Enter for workspaces only | **1 shortcut**, then type + Enter | Ctrl/⌘-K searches workspaces, primary views, Terrain, Folio, setup and recent lessons across workspaces. Escape returns focus to the opener. |
| Home → last lesson, environment or change | No direct action | **1 each** | Continue restores the workspace, depth and destination. For a lab it selects and focuses the saved block. This also works after restart. |
| Approve a tutor request | 1 approval after opening review | **1 approval** | Allow once or allow future tutoring here with this provider. Revoke from the reader. Inspect exact input in one click. |
| Approve a repository source request | 1 approval after opening review | **1 approval** | See provider, files and bytes first. Optional remembered consent is separate for maps and change lessons. Exact request is one click away. |

## Other core journeys

| Journey | Before → after | Finding and outcome |
| --- | --- | --- |
| Explore the map | Select a concept + Open lesson → same 2 actions | Terrain and the accessible Folio list share selection. The suggested concept opens in one click. The primary action stays visible on a 1280 × 800 Atlas and a 4K Atlas. |
| Switch reading depth | 1 selection → 1 | Depth stays in the reader header. The source form puts the initial override in Advanced options. |
| Continue a conversation | Type + submit → same | A new reply preserves the reader's scroll position. An active request can continue when leaving the lesson. Its in-app notice reopens the result in one click. |
| Check understanding | Answer and submit, approve if prompted → same | Written and choice checks expose exact previews and a one-step approval. Progress shows the resulting evidence and recommendation. |
| Practice in an environment | Jump to instrument in 1 → same | The composer leaves room for controls. Returning through Continue focuses the last instrument. Each opening starts a fresh practice session. Recorded observations and evidence persist. |
| Review progress | Header in 1 → same | Empty records lead back to learning. Evidence retains its depth, originating workspace and reset action. |
| Read more repository files | Atlas → file selection → preview → approve | File selection and provider settings collapse. Review the exact request or approve the selected snapshot. Empty and stale inventories give a reload action. |
| Leave map or change generation running | Navigate away; reopen from notice → same | The notification offers cancel, review/retry or open as appropriate. Staying on Atlas shows the finished map in place. |
| Follow a changed line or concept | 1 → 1 | Opens the selected concept on Atlas. Return to reviewed map restores the baseline selection. |
| Accept an incoming learn link | 1 decision → 1 | Workspace and source remain visible before import. Acceptance alone never sends source to a tutor. |
| Recover from a failure | Retry or inspect process text → retry, edit, sign in or change provider | Unknown provider exits show a learner-facing recovery action. A moved change must be reviewed again. Already-saved lessons remain readable offline. |

The mockup's separate Atlas destination remains available through the persistent Atlas action. The change page's Teach action opens the lesson directly in one click; the footprint also opens its concept lesson directly. In repository change briefs, mapped lines and concepts still open the corresponding Atlas focus.

## Verification

The map retains a small, muted React Flow attribution in both themes. Delve and React Flow are MIT-licensed; [React Flow's attribution policy](https://reactflow.dev/remove-attribution) asks projects that remove the badge to subscribe. Keeping it acknowledges the library while fitting the Contour map, unlike the unbadged mockup.

CI runs the journey assertions against the built desktop as part of `npm run test:smoke`. The [action counter](../tests/smoke/action-budget.ts) measures trusted pointer and keyboard events. [Tutor](../tests/smoke/tutor.spec.ts), [repository](../tests/smoke/repository.spec.ts), [Changes](../tests/smoke/explorer.spec.ts) and [navigation](../tests/smoke/navigation.spec.ts) cover the budgets above. Tests exercise actual Git operations and the normal CLI boundary with deterministic provider and GitHub fixtures.

The packaged before/after artifact, **delve-ux-journeys**, includes matching 1280 × 800 captures of setup, Atlas, search, first-use consent, the first lesson, repository attachment, map progress and the selected PR. The accessibility checks exercise keyboard focus, native dialogs, reduced motion and the dark and light designs. Automated checks complement the keyboard and viewport journeys. Verification used Linux and fixture subscription responses.

## Earlier previews

Preview 2 found a rejected hard-coded model and terrain clicks intercepted over Durable queue. Preview 2.5 verified model selection and terrain clicks, then found the sticky composer could intercept instrument controls. Preview 3 confirmed access to the labs, exact reviewed source payloads and one-click timeline navigation. Its first fresh change lesson still needed a separate approval click. These flows are covered by the desktop smoke suite.
