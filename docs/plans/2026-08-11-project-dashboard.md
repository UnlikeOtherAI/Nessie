# Project Dashboard — the interface for running a project

**Date:** 2026-08-11 · **Status:** Design spec, ready to build
**Routes:** `/channels/projects/:projectId` (chat entry) and `/projects/:projectId` (Projects → Overview tab)

---

## 1. Purpose + the one job

The project dashboard is the single at-a-glance surface for *running* a project: where the
conversation is, what work is blocked or late, what was last written down, and who to talk to.
It is a **router, not a report** — every element on it exists to take the user to the place
where they act, and anything that does not enable a decision or an action is off the screen.

---

## 2. Information architecture

### The overview's sections, in priority order

| # | Section | Question it answers | Action it affords |
|---|---------|--------------------|-------------------|
| 1 | **Channels** | Where is the conversation, what have I not read? | Jump into a channel |
| 2 | **Work** | What is late / stuck / in flight? | Open the board filtered by that state |
| 3 | **Documents** | What was last written down? | Open the doc in the Docs workspace |
| 4 | **Members** | Who is here, who is online, who do I ping? | Open a DM; owners manage membership |

That is the whole screen. Four sections, each capped, on one viewport at desktop sizes.
No hero numbers, no timeline, no charts.

### Tab set — where Documents lives

**Documents is both**, deliberately:

- The **Docs tab** (`/projects/:projectId/docs`, `ProjectDocsTab`, already built) stays the
  full working surface — space rail + `KnowledgeWorkspace`. It is the place you *work on*
  documents.
- The overview gets a **Recent documents section** (latest 5 across the whole project) because
  "what changed lately" is a running-the-project question, and answering it inside the Docs tab
  requires opening every space by hand. Each row deep-links into the Docs tab.

The Projects-section tab set is unchanged: `Overview · Board · [Backlog · Insights] · Docs ·
Settings`. The dashboard is the Overview tab's content.

### How the chat entry point relates to the tabs

`/channels/projects/:projectId` renders **only the dashboard** (same shared component), under
its existing 50px header. It does **not** grow a duplicate tab bar: the channels sidebar is
already the navigation context on that side, and two competing nav strips (sidebar + tabs) is
exactly the noise the owner banned. Instead, the dashboard's section-header links *are* the
tabs' equivalents — "Board" from the Work section, "Open docs" from the Documents section,
"Manage" (owners) from the Members section — and they navigate to the Projects-section routes
(`/projects/:projectId/board`, `/docs`, `/settings`). One navigation model per section; the
dashboard is byte-identical in both hosts.

---

## 3. Section-by-section spec

All colour via tokens (`var(--tx)`, `var(--tx2)`, `var(--tx3)`, `var(--sep)`, `var(--panel)`,
`var(--overlay)`, `var(--accent)`, `var(--danger-text)`); each section is an `admin-card` with
a header row reusing the house `text-xs font-semibold uppercase tracking-[0.2em]
text-[color:var(--tx3)]` label style (the same `sectionTitle` constant both host pages already
use). Sections load independently — one slow query never blanks the page.

### 3.1 Channels

- **Data:** `useChannels()` → `GET /api/channels` (cached, `staleTime: Infinity`, already
  loaded by the shell — zero extra requests). Client filter:
  `channel.projectId === projectId && channel.type === 'standard' && !channel.archivedAt &&
  !channel.systemChannelType`. Fields used: `id`, `label`, `topic`, `teamName`, `unreadCount`,
  `visibility`, and `lastMessageAt` (NEW, §7.2).
- **Row anatomy:** `#` glyph (🔒 for `private`) · channel `label` in `text-[color:var(--tx)]`
  (bold when unread) · `topic` truncated single-line in `text-[color:var(--tx3)]` · right-aligned
  unread badge (same pill treatment as the sidebar's `.admin-sb-item.unread` counterpart) ·
  relative `lastMessageAt` ("2h") in `text-[color:var(--tx3)]`. Row height ~40px, hover
  `bg-[color:var(--overlay)]`.
- **Ordering:** unread channels first (descending `unreadCount`), then `lastMessageAt`
  descending; until §7.2 ships, fall back to alphabetical `label` after the unread group. This
  ordering **is** the "last activity" feature — the freshest rooms surface on top with their
  unread counts, without inventing an activity feed.
- **Cap:** 8 rows. When more exist, a final quiet row: "Show all N channels" expands the list
  in place (no separate page exists and none is needed).
- **Header:** `CHANNELS · N` (N = filtered count). No header action — channel creation already
  lives in the sidebar `+` and Settings → Channels.
- **Click:** row → `/channels/:channelId`.
- **Loading:** 3 skeleton rows (`bg-[color:var(--overlay)]`, `animate-pulse`, rounded).
- **Empty:** "No channels yet. Channels created under this project's teams will appear here."

### 3.2 Work

- **Data:** `useTasks(projectId)` → `GET /api/tasks?project=<projectId>` (note: the query param
  is `project`, not `projectId` — `api/src/routes/tasks.ts:84`). Fields: `status`, `dueDate`,
  `archivedAt`.
- **Anatomy:** a single row of count **chips**, not a task list (the Board is one click away and
  two task surfaces drift). Chips, computed over non-archived tasks:
  - `Overdue N` — `dueDate < now` and `status` not `done`/`cancelled`; rendered in
    `text-[color:var(--danger-text)]`; **omitted when 0**.
  - `Awaiting approval N` — `status === 'awaiting_approval'`; **omitted when 0**.
  - `In review N` — `status === 'review'`.
  - `In progress N` — `status === 'in_progress'`.
  - `Open N` — everything not `done`/`cancelled` (the always-present anchor chip).
  Chip = compact pill: `border border-[color:var(--sep)] rounded-full px-2.5 py-1 text-xs`,
  count bold `text-[color:var(--tx)]`, label `text-[color:var(--tx2)]`.
- **Ordering:** exactly the order above — exceptions before steady-state.
- **Header:** `WORK` with a right-aligned "Board →" link (`text-xs`,
  `text-[color:var(--tx3)] hover:text-[color:var(--tx)]`).
- **Click:** every chip and the header link → `/projects/:projectId/board`. (The board has no
  filter query params today; adding them is out of scope — the chip's job is to say *that*
  something is late and put you on the board, which shows it.)
- **Loading:** one skeleton chip row.
- **Empty (zero tasks):** "No tasks yet — open the Board to add the first one." (link on
  "Board").

### 3.3 Documents

- **Data:** NEW endpoint (§7.1): `GET /api/knowledge-base/recent-pages?projectId=<id>&limit=5`
  via a new `useProjectRecentPages(projectId)` hook in `admin/src/facades/knowledge/hooks.ts`
  (query key `['knowledge-recent-pages', projectId]`). Fields per row: `id`, `spaceId`,
  `spaceName`, `title`, `kind` (`document`|`file`), `status`, `updatedAt`.
- **Row anatomy:** kind glyph (📄 document / 📎 file — same glyphs the knowledge tree uses) ·
  `title` in `text-[color:var(--tx)]` · `spaceName` in `text-[color:var(--tx3)]` · relative
  `updatedAt` right-aligned · a small `draft` pill (border + `text-[color:var(--tx3)]`) only
  when `status === 'draft'` (published is the norm and gets no pill; archived is excluded
  server-side).
- **Ordering:** `updatedAt` descending (server-ordered).
- **Cap:** 5. No expansion — the Docs tab is the full surface.
- **Header:** `DOCUMENTS` with right-aligned "Open docs →" → `/projects/:projectId/docs`.
- **Click:** row → `/projects/:projectId/docs?spaceId=<spaceId>&pageId=<id>`. This requires
  `ProjectDocsTab` to learn the same `spaceId`/`pageId` search-param deep-link the Knowledge
  section already implements in `KnowledgeBasePage` (`openPageDeepLink` + `selectSpace`, then
  clear the params) — a small, client-only addition.
- **Loading:** 3 skeleton rows.
- **Empty:** "No documents yet. Open Docs to create this project's first space." ("Docs" links
  to the Docs tab.)

### 3.4 Members

- **Data:** `useProjectMembers(projectId)` → `GET /api/projects/:projectId/members` → `userId`,
  `displayName`, `email`, `role`; presence dots from `usePresenceList(true)` →
  `GET /api/presence` (`userId`, `state`, `statusEmoji`).
- **Row anatomy:** avatar (initials on `pickGradient(userId)` from `admin/src/lib/avatar.ts`,
  28px) with presence dot (online = `var(--accent)`-family token already used by the sidebar
  presence dot; offline = none) · `displayName` `text-[color:var(--tx)]` · `statusEmoji` when
  set · `role` right-aligned in `text-[color:var(--tx3)]` lowercase.
- **Ordering:** role rank (`owner` → `admin` → `member` → `viewer`), then `displayName`
  ascending. Online status does not reorder (stable list beats a shuffling one).
- **Cap:** 8 rows; "Show all N members" expands in place.
- **Header:** `MEMBERS · N`; owners additionally get a right-aligned "Manage →" →
  `/projects/:projectId/settings` (gate on `isOwner` from `useAuthSession`, same check the shell
  uses).
- **Click:** row → open/navigate to the DM with that user, using the exact logic
  `useAdminShell.navigateToDm` implements (find existing DM channel via `useUsers` +
  `isUserDmChannel`, else `useOpenDm().mutate`). Extract that logic into a small shared hook
  rather than duplicating it (see §6).
- **Loading:** 3 skeleton rows with circle placeholders.
- **Empty:** effectively unreachable (the creator is always a member); render "No members yet.
  Owners can add people in Settings." defensively.

---

## 4. Rejected ideas — and why

1. **Activity feed / timeline.** There is no project activity REST endpoint; building one means
   mining `TaskEvent`/message tables into a new read model. More importantly a feed is a
   *report you scroll*, not an action you take — the unread-first, recency-ordered channel list
   already answers "where did something happen" and lands you in the room where you respond.
2. **Stat tile row (member / channel / task counts as hero numbers).** Vanity numbers with no
   verb attached. The counts appear where they earn keep: inline in the section headers
   (`CHANNELS · 7`, `MEMBERS · 5`).
3. **Pending-approvals chip.** The approvals list response the admin consumes
   (`ApprovalsPage`'s `ApprovalRequest`) carries no project/channel linkage, so a per-project
   count can't be derived honestly client-side; an org-wide count on a project screen would
   mislead. Approvals already have the top-bar bell and `/approvals`. Task-level approval
   pressure *is* shown, via the `Awaiting approval` work chip (task `status`).
4. **Active-runs panel.** `useActiveRuns` polls every 5s org-wide; runs are surfaced (with
   cancel/restart/continue controls that must live beside them) on Agents → Activity. A
   read-only mirror here adds polling load and a second surface to keep consistent, and running
   agents announce themselves in-channel via thinking bubbles anyway.
5. **Token/cost/usage and storage widgets.** Owner-only local telemetry is deliberately
   quarantined at `/ops/usage` and must never sit on a member-visible surface (hard rule in
   AGENTS.md); commercial figures belong to UOA at `/tokens`. Both disqualified outright.
6. **Project description / README block.** `Project` has no description field (`name` only —
   `api/src/routes/projects.ts`); adding schema for a paragraph of prose nobody maintains is
   the definition of filler. A project that wants a front page writes a doc — which then shows
   up in Recent documents on merit.
7. **Task list preview (top N tasks).** Duplicates the Board one click away; two task surfaces
   with different ordering/filtering rules inevitably disagree. Counts route, the board shows.
8. **Recent-messages preview.** Requires per-channel message fetches (N requests) and
   reproduces a worse chat UI inside a card. The channel rows' unread badges + recency ordering
   carry the same signal for free.
9. **Quick-actions block ("New channel / New task / New doc").** Every create affordance
   already exists one click away in its owning surface (sidebar `+`, Board's New task button,
   Docs' Create space). A button strip that re-implements three dialogs is maintenance without
   information.
10. **Duplicate tab bar on the chat entry point.** Two navigation strips (channels sidebar +
    project tabs) fighting on one screen; section-header links cover the same destinations.
11. **Charts (burndown, velocity, doc-activity sparklines).** Scrum projects already have the
    Insights tab; everyone else gets decoration, not decisions.
12. **Agents/triggers panels.** Agent management is org-level (`/agents`), not project-level;
    there is no project→agent binding to render truthfully.
13. **A `GET /api/projects/:projectId/activity` endpoint.** Explicitly not proposed — see (1);
    we refuse the feature, so we refuse its infrastructure.

---

## 5. Layout

Both entry points sit in the same shell geometry: 65px icon rail + 260px secondary sidebar
(channels sidebar on the chat side, Projects nav on the Projects side), content fills the rest.
At 1440px viewport that leaves ~1115px; the dashboard body is `max-w-[1040px] mx-auto p-6`.
The only difference between hosts is the 50px page header above the dashboard (chat entry:
project name; Projects entry: name + tab nav) — the dashboard component renders no header of
its own.

### Desktop (≥900px content width) — two-column grid

`grid grid-cols-[minmax(0,1fr)_320px] gap-6 items-start`

```
┌────────────────────────────────────────────┬──────────────────────┐
│ CHANNELS · 7                               │ WORK          Board →│
│ ┌────────────────────────────────────────┐ │ ┌──────────────────┐ │
│ │ # design            What we ship…  ③ 2h│ │ │ Overdue 2        │ │
│ │ # backend           API contracts  ① 4h│ │ │ Awaiting appr. 1 │ │
│ │ # general           —              1d  │ │ │ In review 3      │ │
│ │ 🔒 leadership       Q3 planning    3d  │ │ │ In progress 5    │ │
│ │ …up to 8 rows                          │ │ │ Open 14          │ │
│ │ Show all 12 channels                   │ │ └──────────────────┘ │
│ └────────────────────────────────────────┘ │                      │
│                                            │ MEMBERS · 5  Manage →│
│ DOCUMENTS                       Open docs →│ ┌──────────────────┐ │
│ ┌────────────────────────────────────────┐ │ │ ● Ada L.    owner│ │
│ │ 📄 Launch plan      Planning   2h      │ │ │ ● Grace H.  admin│ │
│ │ 📄 API notes  draft Engineering 1d     │ │ │ ○ Alan T.  member│ │
│ │ 📎 logo.pdf         Brand      3d      │ │ │ …up to 8 rows    │ │
│ │ …up to 5 rows                          │ │ │ Show all 9       │ │
│ └────────────────────────────────────────┘ │ └──────────────────┘ │
└────────────────────────────────────────────┴──────────────────────┘
```

### Mobile / narrow (<900px content width) — single stack

Order: Work (one thin row — cheapest, highest urgency), Channels, Documents, Members. The
hosts' existing headers already carry `MobileMenuButton`; nothing extra is needed for phone
layouts.

```
┌──────────────────────────────┐
│ ☰  PROJECT NAME              │  ← host page header (existing)
├──────────────────────────────┤
│ WORK                  Board →│
│ (Overdue 2)(In review 3)…    │
├──────────────────────────────┤
│ CHANNELS · 7                 │
│ # design           ③   2h    │
│ # backend          ①   4h    │
│ …                            │
├──────────────────────────────┤
│ DOCUMENTS         Open docs →│
│ 📄 Launch plan  Planning  2h │
│ …                            │
├──────────────────────────────┤
│ MEMBERS · 5         Manage → │
│ ● Ada Lovelace         owner │
│ …                            │
└──────────────────────────────┘
```

Breakpoint: use a container-level `@media`/Tailwind `min-[900px]:` on the grid (the shell's
phone/tablet plumbing stays untouched).

---

## 6. Component plan

All new components under `admin/src/components/features/projects/`; all data access through
facades (house rule — no `apiClient` calls inside components).

| File | Role | Shared? |
|------|------|---------|
| `ProjectDashboard.tsx` | Container: grid layout, mounts the four sections. Props: `{ projectId: string }`. No header, no fetching of its own. | **Shared — the whole point.** |
| `ProjectChannelsSection.tsx` | §3.1. Consumes `useChannels()` + filters. | Shared |
| `ProjectWorkSection.tsx` | §3.2. Consumes `useTasks(projectId)`. | Shared |
| `ProjectDocumentsSection.tsx` | §3.3. Consumes `useProjectRecentPages(projectId)`. | Shared |
| `ProjectMembersSection.tsx` | §3.4. Consumes `useProjectMembers`, `usePresenceList`, DM hook. | Shared |
| `DashboardSectionCard.tsx` | Tiny presentational wrapper: `admin-card` + header row (label, count, right link) + body slot — keeps the four sections' chrome identical. | Shared |
| `ProjectOverviewPlaceholder.tsx` | **Deleted.** | — |

Facade additions:

- `admin/src/facades/knowledge/hooks.ts` — `useProjectRecentPages(projectId)` (new query, §7.1).
- `admin/src/facades/channels/dm-navigation.ts` (new) — `useNavigateToDm()`: extract the
  find-existing-DM-else-open logic currently inlined in `useAdminShell.navigateToDm` so the
  Members section and the shell share one implementation instead of forking it.

Host wiring (the only page edits):

- `admin/src/pages/channels/ChannelProjectOverviewPage.tsx` — replace
  `<ProjectOverviewPlaceholder …/>` with `<ProjectDashboard projectId={projectId} />`.
- `admin/src/pages/project/ProjectView.tsx` — same swap in the `overview` branch.
- `admin/src/pages/project/ProjectDocsTab.tsx` — add `spaceId`/`pageId` search-param deep-link
  handling (mirror `KnowledgeBasePage`: on mount with params, `selectSpace` +
  `openPageDeepLink`, then clear params).

No entry-point prop, no render forks: link targets are identical from both hosts (channel rows
→ `/channels/:id`; everything else → `/projects/:projectId/...`).

---

## 7. Data/API gaps

### 7.1 NEW — `GET /api/knowledge-base/recent-pages?projectId=<id>&limit=<n>`

The only new endpoint this screen needs.

- **Contract:** query `projectId` (required, must be accessible to the actor — same
  `isProjectAccessibleToActor` gate the project routes use), `limit` (default 5, max 20).
  Response `data`: array of
  `{ id, spaceId, spaceName, title, kind, status, summary, updatedAt }`, ordered `updatedAt`
  desc, spanning **only spaces the caller can read** (the provider's existing per-space
  read-access filtering, the same enforcement `GET /spaces?projectId=` performs), excluding
  `archived` pages and archived spaces.
- **Where:** `api/src/routes/knowledge-base.ts` beside the other space/page reads, implemented
  through the knowledge provider (which owns access filtering) — not a raw Prisma query in the
  route.
- **Why client-side assembly is not good enough:** the client would need
  `GET /spaces?projectId=` (1 request) then `GET /spaces/:id/pages` **per space** — 1+N
  requests with N unbounded, each returning full page lists (with version envelopes) only to
  throw away everything but five rows. Per-space read access is enforced server-side in the
  provider; fanning out from the client re-derives that expensively and pushes page-sized
  payloads over the wire for a 5-row card.

### 7.2 NEW field — `ChannelRecord.lastMessageAt: string | null`

- **Contract:** additive nullable ISO timestamp on the existing channel record
  (`api/src/contracts/workspace.ts`), populated in `mapChannelRecord` /
  `loadUnreadCountsByThread` (`api/src/services/channel-records.ts`) by adding
  `MAX(m.created_at)` over the default thread's messages to the channel-list query path — the
  `(thread_id, created_at)` index that already serves the unread computation makes the MAX an
  index-tail read. `null` for message-less channels.
- **Why:** it is the honest, cheap version of "last activity" — it orders the channel list by
  recency and stamps each row with a relative time. The client-side alternative is fetching
  message pages per channel (N requests on a cached-forever list), which is disqualifying.
- **Fallback:** the dashboard ships with alphabetical fallback ordering, so 7.2 can land in a
  separate turn without blocking the screen.

### 7.3 Explicit non-gaps

- **Tasks:** `GET /api/tasks?project=<projectId>` already exists (param is `project`, not
  `projectId`) and `useTasks(projectId)` already calls it.
- **Members, channels, presence, spaces:** all served by existing endpoints/hooks; the
  channels list is already resident from the shell (zero marginal requests).
- **No project activity endpoint** — deliberately not proposed (§4.1, §4.13).

---

## 8. Acceptance criteria

1. `/channels/projects/:projectId` and `/projects/:projectId` both render the same
   `ProjectDashboard` component (verified by a single shared component in the tree, not
   copy-paste), and `ProjectOverviewPlaceholder.tsx` is deleted with no remaining imports.
2. The dashboard shows exactly four sections — Channels, Work, Documents, Members — and nothing
   else; desktop ≥900px content width renders the 2-column grid (Channels+Documents left,
   Work+Members right), below that a single stack ordered Work, Channels, Documents, Members.
3. Channels section lists only this project's non-archived, non-system `standard` channels;
   unread channels sort first with badges whose counts equal the sidebar's badges (same
   `unreadCount` source); rows navigate to `/channels/:channelId`; more than 8 channels shows
   "Show all N channels" which expands in place.
4. Work section renders count chips from `GET /api/tasks?project=<id>` with Overdue and
   Awaiting-approval chips omitted at zero, Overdue tinted `var(--danger-text)`, and every chip
   plus the "Board →" header link navigating to `/projects/:projectId/board`.
5. Documents section calls the new `GET /api/knowledge-base/recent-pages?projectId=&limit=5`,
   renders at most 5 rows ordered by `updatedAt` desc with kind glyph, space name, relative
   time, and a `draft` pill only for drafts; a row navigates to
   `/projects/:projectId/docs?spaceId=…&pageId=…` and the Docs tab opens that page (deep-link
   params handled and then cleared); "Open docs →" reaches the Docs tab.
6. The recent-pages endpoint returns only pages in spaces the caller can read (test: a user
   without access to a private space in the project never receives its pages), rejects
   inaccessible/foreign `projectId` with 404, caps `limit` at 20, and excludes archived pages
   and spaces.
7. Members section lists members ordered owner→admin→member→viewer then name, with initials
   avatars (`pickGradient`), presence dots from `/api/presence`, role labels; clicking a member
   opens the DM (existing DM reused, else created) via the shared `useNavigateToDm` hook, which
   `useAdminShell` also consumes (no duplicated DM-resolution logic); "Manage →" appears for
   owners only and reaches `/projects/:projectId/settings`.
8. Every section has an independent skeleton loading state and the specified empty-state copy;
   a failing section shows its empty/error state without blanking the other three.
9. No raw hex, no Tailwind named colours: all colour via `var(--…)` tokens; cards use
   `admin-card`; verified visually in at least the default (nebula) theme in light and dark.
10. Mobile: at phone width both entry points show the host's existing 50px header with
    `MobileMenuButton`, and the dashboard stacks in a single scrollable column with no
    horizontal overflow.
11. No owner-only telemetry (tokens, cost, storage, budgets) and no org-wide counters appear
    anywhere on the dashboard.
12. `ChannelRecord.lastMessageAt` (when landed) is additive and nullable; channel ordering uses
    it with alphabetical fallback, and the dashboard functions unchanged when the field is
    absent.
13. Playwright verification (headless, `http://localhost:5455`): screenshots of
    `/channels/projects/:id` and `/projects/:id` on a seeded project confirm all four sections
    render with data, plus one phone-width screenshot; lint and typecheck pass; root build's
    lint gate untouched.
