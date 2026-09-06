# Agent browser tabs, last state and resume — as built (2026-09-06)

A chapter of [2026-09-02-browserbase-cloud-browsers.md](2026-09-02-browserbase-cloud-browsers.md)
(§5d), split out to keep that plan under the repo's file-length cap. It
records what shipped and where the parent plan's §4.9, §4.4 and §5a/§5b are
now stale; the invariants that did not change are still stated there.

## What changed

- **The doorways are a tool rail and a route, not the three in §4.9.** A
  conversation with one agent has a persistent tool rail beside it
  (`components/features/channels/tool-rail/`); Browser is its first tool and
  opens the browser panel as a column at `xl`+, a layer below that. A
  single-column layout has no rail: the doorway is a primary Browser action in
  the conversation header (`chatToolDoorway`), drawn as the two-pane glyph and
  the only action the iOS bar shows inline, and the panel is the route
  `/channels/:channelId/tools/browser`. There is no session id in any URL, no
  thinking-bubble chip, and no thumbnail in the info drawer (its only link
  was a 404). The sign-in card's "Open the browser" now points at the route.
- **"One right panel at a time" is false from `2xl` up**, where a reply thread
  and the browser panel stand side by side with a shared, linked separator
  (`useSidePanelGeometry`'s registry). Below that the rail says why it cannot
  open a second column and never closes the other panel.
- **The panel exists without a session.** Idle it shows where the browser
  left off: `agent_browser_tabs` (position, URL, title, a JPEG in the row,
  `captured_at`), rewritten as a set after `browser_open`, after every
  `browser_act` (scheduled, single-flight per session), at `browser_close`,
  on the run's terminal transition, and when a resumed session is handed back
  or released. The window is always there — a drawn browser when there is no
  picture — and tapping it is the resume.
- **The worker no longer owns every CDP connection.** A run's session is
  captured over the pool's socket (a second automation connection can end the
  session). A *resumed* session has no worker: the API dials it to restore
  tabs, and the release path — reaper included — dials it to capture, both
  under `CAPTURE_TIMEOUT_MS`.
- **§4.4 step 2 is the resume.** `POST /api/threads/:threadId/agents/:agentId/browser/resume`
  opens a session on the agent's durable context with **`run_id` NULL**, on the
  connection the browser already lives on; it lives on `resumeIdleMs`
  (`NESSIE_BROWSER_CLOUD_RESUME_IDLE_MS`, ≤ the run TTL), extended by every read
  of its live view and capped at `startedAt + ttlMs`; the reaper stops it. The
  panel goes full screen and claims the controls for the person; **Done**
  (`DELETE /api/browser-sessions/:id`) captures and releases. While it is up,
  the agent's `browser_open` sees "open in another run". §4.8's spend bound
  now includes the idle window and the per-open tab restore.
- **One audience rule** (`viewerMaySeeAgentBrowser`): a browser nobody signed
  in is visible to whoever can reach the conversation; once signed in, to its
  signers and the session's requester. The session detail, the session list,
  the stored tabs (others get the site and no picture) and the resume all use
  it. Hand-back writes at most one synthetic login row per person per browser.
- **§5a/§5b:** the disclosure row is always present with "Browsing now" while
  live; the browser panel lives in the chat as well as on the agent's Tools
  tab. Open question for §7: screenshots of signed-in pages sit unencrypted in
  the database (see `docs/standards/file-storage.md`).

