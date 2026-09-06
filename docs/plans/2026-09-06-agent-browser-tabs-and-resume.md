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


## Window size and home page (shipped 2026-09-06)

- **A browser's window is stored on the browser, not on the person or the
  conversation.** `agent_browsers.viewport_width/height`, read when a session
  opens. It is a property of the work: an agent that reads a dashboard needs a
  wide page every time it opens one, whoever asked. That puts it per-person
  exactly where the browser already is — a system-managed agent's browser is
  one row per principal, so sizing the Personal Assistant's window sizes one
  person's and nobody else's. Null means `DEFAULT_BROWSER_VIEWPORT` (1280×800),
  which keeps every pre-existing row on the default with no backfill.
- **Browserbase fixes a viewport at session creation.** The stored pair is
  therefore what the *next* session opens at, and a session already on screen
  is resized through `Emulation.setDeviceMetricsOverride` — a page-level
  override, best effort, and **only when the caller holds the control claim**.
  Reflowing a page an agent is working on mid-run would move every element it
  had just located; the row is written either way, and the viewer says when a
  resize is waiting rather than appearing to do nothing.
- **`agent_browsers_viewport_chk` refuses half a pair** and anything outside
  320..3840 × 320..2160. `BrowserViewportSchema`
  (`packages/schemas/src/browser-preferences.ts`) carries the same bounds, so a
  value the route accepts is one the database accepts.
- **The home page is a scoped setting**, `browser.homepage`, cascading
  organisation → team → user with the same lock semantics as
  `browser.connection`. It is resolved server-side on every use: a client that
  resolved it would be a second implementation of the cascade.
- **`http`/`https` only, never credentialed.** This value is typed by an
  administrator and then navigated to *inside an agent's browser*, where a
  `javascript:` URL would run in the live view's page and a `user:pass@` one
  would put a password in the tab strip and in every capture of it.
  `isNavigableHomepage` is the one gate, used by the schema the field validates
  with and by `resolveBrowserHomepage`, which falls back to the default rather
  than failing a session open on an unusable stored value.
- **A resume with no stored tabs lands on the home page** rather than a blank
  page, best effort — a browser that came up but did not reach its home page is
  still a working browser, and releasing it would turn a cosmetic miss into a
  resume that failed. The address is passed in by the caller; this package
  holds no settings reader.
