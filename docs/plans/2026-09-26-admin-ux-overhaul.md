# Admin UX overhaul: audit and proposal

**Date:** 2026-09-26 · **Status:** proposal for decision · **Scope:** everything a
person reaches through the Admin rail item, plus the settings that live on a
project and a conversation, because the org/team/project/user duplication cannot
be judged without them. Workflows (`/agents/workflows`, the workflow designer)
are deliberately out of scope and get their own session; they appear here only
as a row that keeps its place.

The audience this is designed for: corporate knowledge workers and their IT or
operations administrators, none of whom have written software. The standard
applied throughout is the one already in `AGENTS.md` → Rule zero: one home per
capability, a doorway where the question arises, every element names the
decision it drives, and one component per surface.

## Table of Contents

1. [Verdict](#1-verdict)
2. [How the audit was done](#2-how-the-audit-was-done)
3. [What exists today](#3-what-exists-today)
4. [Why people are lost](#4-why-people-are-lost)
5. [Design rules for the new admin](#5-design-rules-for-the-new-admin)
6. [The new information architecture](#6-the-new-information-architecture)
7. [Vocabulary](#7-vocabulary)
8. [Where every current function goes](#8-where-every-current-function-goes)
9. [AI-slop candidates and what to do with each](#9-ai-slop-candidates-and-what-to-do-with-each)
10. [API and process changes this needs](#10-api-and-process-changes-this-needs)
11. [What must not change](#11-what-must-not-change)
12. [Decisions still owed](#12-decisions-still-owed)
13. [Rollout order](#13-rollout-order)
14. [The parallel model runs](#14-the-parallel-model-runs)

## 1. Verdict

The admin is organised the way the code is organised, not the way a person
thinks. Its sidebar is six groups and twenty-seven items in which the same five
labels (Settings, Secrets, Models, Members, Paired agents) recur two or three
times, distinguished only by a group heading; the most technical screens in the
product (a 253-row tool registry with JSON schemas, a `tool.view → role:*`
policy editor, per-million-token pricing, dead-letter queues) sit in the same
list as a person's theme picker; and the one question people actually ask,
"how do I connect X so that agent Y can use it", has fourteen different
answers depending on what X is, with five different places to paste a key and
seven status vocabularies.

Nothing here needs to be removed to fix it. Almost every screen is load-bearing
for a real rule (SSO owns identity, secrets cascade with visible locks, grants
are explicit, approvals live in chat). What has to change is the *shape*:

- **Two front doors instead of one "Admin".** Personal settings move behind the
  avatar, where every product puts them. "Admin" becomes a rail item that only
  administrators see, holding organisation and team management. Agents, apps,
  computers and automations become a first-class section for everyone.
- **One page per concern, scope as a facet.** Models, keys, people and company
  connections are one page each, with the organisation/team level shown *on*
  the page (a scope switch, an "inherited from organisation" chip, a lock),
  never as a second copy of the page.
- **One model of connection.** Accounts (a login at another service), apps
  (a capability package from the catalogue), computers (a paired machine) and
  keys (a saved credential), each with one status vocabulary and one "agents
  with access" control that is the same component everywhere and mirrored on
  the agent's own Access tab.
- **A developer layer that is present but not in the way.** Registry JSON,
  raw access rules, model pricing, system health and push certificates live in
  one collapsed "Advanced" group for owners and instance operators.
- **Corporate words.** Executor becomes computer, paired agent becomes a
  program signed in as you, secret becomes saved key, inference provider
  becomes AI model, and no vendor or protocol name (UOA, Infisical, Ledger,
  Browserbase, MCP, IMAP) appears in a label.

The result is nine personal pages, four agent-section pages, ten admin pages
plus an Advanced group, with zero repeated labels, and every function in the
mapping table of §8 has a named new home.

## 2. How the audit was done

- Seven parallel read-only audits of the source at `main` (`b76c47072`), one
  per slice: shell and navigation; the User group; the Team and Organisation
  groups; Agents, Tools, Executors, Triggers and Task Sets; Apps and every kind
  of connection; Governance and Platform; project and conversation settings.
  Each report inventories every route, tab, control, entitlement and API call,
  and cites `path:line`. They are reproduced in condensed form in §3 and §8.
- Every admin route was then opened in a real browser against this worktree's
  own API and admin (5454/5455, the shared local database) at 1280 px, and the
  screens were read alongside the code. The screenshots are kept outside the
  repository.
- The standards the redesign must keep were read in full: `team-model.md`,
  `scoped-settings.md`, `design-system.md`, `app-store.md`,
  `mcp-connectors.md`, `connected-mailboxes.md`, `paired-agents.md`,
  `executor-sharing.md`, `inference-model-availability.md`,
  `customer-billing.md`, `approval-gating-spec.md`, and the navigation
  rulebook. Their constraints are listed in §11 and honoured in §6.
- Two other models were given the identical task in parallel for a second
  opinion (§14).

## 3. What exists today

The rail is Channels · Projects · Knowledge · Admin · (Search on phones).
"Admin" opens `/settings`, which redirects everyone, including a plain member,
to their own Profile tab. The Admin sidebar, with who sees each item:

| Group | Items (visibility) |
|---|---|
| Agents | Agents · Workflows · Task Sets · Triggers (list owner-only) · Tools (owner) · Executors · Apps |
| User | Settings (tabs Profile, Agents, Notifications, Appearance, Security) · Secrets · Connected accounts (tabs Email, AI inference provider, Slack, Calendar & Meet, Project tools) · Paired agents · Statuses |
| Team | Settings (tabs Profile, Agents; owner or admin) · Models (owner or admin) · Secrets (owner) · Members (any member on SSO, owner locally) |
| Organisation (SSO org admins only) | Settings (tabs Profile, Agents, Appearance) · Secrets (owner) · Models (owner) · Paired agents · Members |
| Governance | Credits & billing |
| Platform (owner or super-admin) | Health (super-admin) · Push credentials (super-admin) · Audit log · Policy · Operational usage |

Pages that exist but are in no sidebar: `/alerts` (only from the bell, which
phones and native shells do not show), `/feedback` (avatar menu), `/mail`,
`/agents/executor-sessions`, `/agents/:id/mailbox`. A project has sections
Overview, Boards, Backlog and Insights (scrum only), Docs, Dashboards,
Executors (a read-only list) and Settings (only Fields and Sources; the name,
picture, members and visibility live elsewhere). A conversation has a settings
dialog (Channel, Agent decisions), a members popup, a three-route "Conversation
info" flow, and Automations and Agents tabs.

Fourteen distinct kinds of connection exist, each with its own home, status
words and grant mechanism: app (MCP connector) instances at person, channel or
project scope; Gmail, Outlook and Slack OAuth "comms" connections; Google
Workspace capability scopes on those connections; standing send grants;
IMAP/SMTP mailboxes (personal or shared); the `/mail` reader; vault secrets
(which no connector reads); paired-agent credentials (an outside program acting
*as* the person); executor pairing; DeepWater team enablement; the Browserbase
cloud-browser key at three cascading levels; personal AI-plan subscriptions;
local Ollama hosts; and project-tool (Jira, Linear, Trello, GitHub) connections
for board sources. Gmail can be reached four ways (an App Store row, a comms
connection, the Calendar & Meet tab, an IMAP mailbox), Slack twice, Jira and
Linear three ways.

The full per-control inventory is the "Today" column of §8.

## 4. Why people are lost

Each diagnosis below is what a corporate user meets, with the evidence.

**D1. "Admin" is where everyone's personal settings live.** A member who wants
a different theme must open a rail item called Admin and scroll past Agents,
Workflows, Task Sets and Triggers to find "User › Settings". The page that
opens is titled Profile, and its second card is a Session ID, an issue
timestamp and "Auto redirect: Disabled". The same list shows an org
administrator twenty-seven items and a member seventeen, so no two people can
describe the sidebar to each other.

**D2. The same label three times.** Settings, Secrets, Models, Members and
Paired agents appear under two or three headings with the same icon. "Agents"
is a group, an item, a tab on three settings pages, and a Knowledge row. Which
"Members" removes someone from the company and which one from a team is
learned by trial. On a local (non-SSO) install the Team › Members page is
broken by construction: it renders the SSO roster component and says "This
team has lost its connection to UnlikeOtherAI".

**D3. Fourteen ways to connect, no rule for which one.** Connected accounts
holds five tabs whose contents do not match their names (Calendar & Meet has
no list; its result appears under Email labelled "Gmail"; the Email tab stacks
a synced-accounts table with statuses Healthy/Needs reauthorization above a
"Live IMAP mailboxes" card with statuses Connected/Switched off/Needs
reconnecting). The cloud browser is under Settings › Agents, not Connected
accounts. The App Store offers a community "Gmail" and "Slack" beside the
first-party Google and Slack sign-ins with no cross-link. A key can be pasted
into an app's "Add an API key", the Browserbase "API key", a subscription's
"Subscription key", a project source's key form, or Secrets › New secret, and
none of the five is interchangeable. The grant that lets an agent use a
mailbox needs two switches on two pages (the mailbox row and the agent's Tools
tab); an app needs a per-agent switch plus, for shared installs, an owner
approval on a third page (Tools).

**D4. Developer surfaces are first-class navigation.** Tools is 253 rows of
`browser_act`, `executor.browser.connected.act`, "EXECUTOR EXECUTOR" badges and
JSON input schemas. Policy is `ALLOW tool.view · organization:00000000 →
role:* · priority 100` with a Delete that can lock every member out of every
channel. Operational usage asks for "Input $/M · Cache read $/M" before any
cost figure is non-zero, and its budgets offer "Degrade — cheaper model over
cap". Executors introduces itself as "governed sandboxes and coding sessions"
and offers Reviewed drafts, Sessions and Manage apps in its header. Trigger
rows print `needs_reauthorization`. Every one of these is real and some of it
is load-bearing (§9 says which), but none of it belongs in the first list a
manager opens.

**D5. Duplication across levels without a visible rule.** The settings cascade
(organisation → team → person, with locks) exists and is well built, but it is
rendered as separate pages per level: Models ×2, Secrets ×3, cloud browser and
local Ollama on three differently shaped pages (org Models, team Settings ›
Agents, org Member details). Call provider is a team setting managed only from
the organisation page; shared mailboxes are team-scoped and appear only under
Organisation › Agents. Team items gate on local roles while Organisation items
gate on the live SSO capability, so an SSO org admin sees a group missing two
rows with no explanation, and Org › Models opens for them and then answers
"Owner access required" on every request.

**D6. Patterns decided per page.** Account settings folds five things into
tabs; Secrets, Connected accounts, Paired agents and Statuses are sidebar
siblings; Team folds two and leaves three siblings; Organisation folds three
and leaves four. Team › Settings is one field ("Team name"). Credits & billing
on a deployment without SSO billing is a single row reading "Nessie Team seats
· NEEDS BACKEND · Manage seats". Project settings is Fields and Sources while
the project's name, picture, members, boards, labels and visibility are five
other places, and its Overview tile promises "Name, teams, boards, fields".

**D7. Doorways missing or doubled.** `/alerts` is unreachable on every phone
and native shell and in focus mode, so invitations and "a scheduled task
stopped running" are invisible there. A project has two overview routes
(`/projects/:id` and `/channels/projects/:id`). Executors are reached four ways
(Agents group, avatar menu, project section, a sessions page in no nav).
Feedback carries the eyebrow "General", a group that does not exist.

**D8. Words.** Executor, paired agent, MCP client, secret key vs reference,
precedence, scope key, inference provider, Infisical, Browserbase,
UnlikeOtherAI, Ledger, cron, webhook, JSONL, Kelpie. "Organisation" and
"Organization" both appear. "Automatic logins" names a feature whose own lede
says it is not about logging in. Statuses, executors and triggers all have
their own status words. A status row is `personal · active`.

## 5. Design rules for the new admin

R1. **Personal is not admin.** Anything about *me* (profile, notifications,
theme, my accounts, my computers, my keys, my security) lives under the avatar
as "Your settings". "Admin" is only for people who administer a team or the
organisation, and members never see it.

R2. **Building blocks are a section, not an admin task.** Agents, the apps
and accounts they use, the computers they run on, and the schedules that wake
them are the product's working parts and get a rail item for everyone.

R3. **One page per concern; scope is a facet of the page.** A thing that
exists at organisation and team level is one page with a scope switch and
inline inheritance ("Set by organisation · locked"). The team page collects the
team's overrides as links back into those pages. Never two sidebar items with
the same label.

R4. **Four nouns for connection, one grant.** Account, app, computer, key.
Every connected thing has one object page whose "Agents with access" section
is the one grant control; the agent's Access tab is the same component seen
from the agent's side. One status vocabulary of five words (§7).

R5. **Sentences, not enums; no vendor names in labels.** A status is a sentence
that says what to do ("Stopped: sign in to Google again"). Vendor names may
appear once in help text where a person needs them (the sign-in page they will
be sent to), never in a label or heading.

R6. **The developer layer is one collapsed group.** Tool registry, access
rules, model pricing, system health, push certificates and session debugging
stay, under Admin › Advanced, visible to owners and instance operators only.
Nothing in the everyday path shows a JSON schema, an id, or a per-million
price.

R7. **Reachable everywhere the question arises.** Alerts on every shell; each
object page linked from the rows that name it; old routes redirect.

R8. **One page anatomy.** Header with the title and at most one primary action;
an optional single tab strip (at most six tabs); flat sections separated by
dividers (no nested cards); the shared table with the shared footer; empty
states that name the next step and its doorway.

R9. **Entitlement shapes, never hides what could be earned.** Whole sections a
person can never use are absent (the Admin rail item for a member). A control
that a person could use with more standing is present, disabled, and says who
can change it, which is the existing `ScopedSettingGate` rule extended to every
gate.

## 6. The new information architecture

### 6.1 Top-level navigation

Rail: **Channels · Projects · Knowledge · Agents · Admin**, with Admin shown
only to a person who administers at least one team or the organisation, or is
an instance operator. Bottom of the rail as today: Focus, Create, avatar. Top
bar as today: back, forward, recent, search, alerts bell, and the bell is added
to the phone home header and the native root bars so `/alerts` is reachable on
every shell.

Why: the section ids are a wire contract with the installed native shells and
the surface registry, so the change is exactly one added section (`agents`)
and one conditional one (`admin` becomes entitlement-shaped rather than
always-on). Channels, Projects and Knowledge keep their ids. Renaming Knowledge
to Documents is a separate decision (§12).

Avatar menu: Availability · Status · **Your settings** · **Admin** (when
entitled) · Send feedback · Sign out. The Executors rows leave the menu (their
home is Agents › Computers and Your settings › Your computers); Debug moves to
Advanced; Full refresh stays only on native shells.

Team switcher: unchanged in function, but the desktop trigger shows
"Organisation › Team" as text beside the avatar, "Add team" opens Admin › Teams
› New team, and "Create an organisation…" is its own menu row with its own
dialog, so founding an organisation is never one tab away from adding a team.

### 6.2 Your settings (avatar → Your settings; `/settings/*`)

One list of pages on the left (the list is the page on a phone), each page a
single scrolling form. Nine pages:

| Page | Holds | Why it is a page |
|---|---|---|
| **Profile** | Photo; name and email (read-only, "Managed by your sign-in provider" when SSO); the organisations and teams you are in, each with Switch; language when it exists | The identity card everyone expects first. The Session card leaves (→ Security). |
| **Notifications** | Focus mode; push on/off and "notify me about" (Budget alerts shown only to owners); quiet hours; browser notifications; muted conversations (only the muted ones, with Unmute) | Unchanged in function; the muted list stops listing every private conversation with a raw visibility word. |
| **Appearance** | Theme (12 built-ins plus the organisation palette, marked Default); text size; app icon (iOS only) | Unchanged. |
| **Status** | Emoji, label, schedules; Set active / Clear; availability Auto/Active/Away | The half of Statuses the product consumes. Response agent and contact rules are held back (§9). |
| **Connected accounts** | One list of the person's accounts at other services: Google Workspace (mail, calendar, meet as capabilities), Microsoft 365, Slack, other email provider (IMAP), Jira, Linear, GitHub, Trello, your AI plans (Kimi, GLM, DeepSeek, Codex, Grok), cloud browser. Rows are grouped by purpose (Mail and calendar · Chat · Tickets and code · Browsers · AI plans); each row: service, account, status sentence, "N agents may use this", Reconnect, Disconnect. "Connect an account" opens the same picker the Apps catalogue uses, filtered to things a person can connect for themselves. | This is the answer to "how do I connect X". It merges the five Connected-accounts tabs, the Account › Agents cloud-browser panel, and personal-scope app installs from the store, which are the same thing seen from the store. |
| **Your computers** | Computers you paired: pair this computer / pair with a code; per computer: status, what it offers (files, programs, local apps, AI models on it), which agents may use it, sharing, lifecycle | A person owns the machines they pair; sharing and agent access are actions on the machine, so the same object page as Agents › Computers, filtered to mine. |
| **Saved keys** | Every vault key that reaches you, with where it comes from (Organisation · Team · Project · Yours), Locked and Overridden shown as chips; Add a key (for you, or for a project you are in); Revoke | The personal Secrets page, renamed, with the same cascade table. |
| **Usage** | Your credit usage and the team totals (the member projection of Credits & billing); present only when the billing service is configured | Every member may see their own usage today; it does not belong beside administration. |
| **Security** | Active sessions and devices (this device marked); programs signed in as you (pair with a code, Allow / Don't allow, revoke, `?code=` links land here); password (local accounts only) | Sessions and paired programs are both "things that hold my login", so they are one page. |

### 6.3 Agents (rail item; everyone)

Sidebar: **Agents · Apps · Computers · Automations**.

**Agents.** Tabs Mine · Shared · Built-in, a New agent action, the same table
(name, visibility pill, owner, availability sentence, open its conversation).
An agent's page keeps the identity header (avatar, name, role, status
sentence, owner, Stop while running, Open conversation) and has six tabs:

| Tab | Holds | Replaces |
|---|---|---|
| Overview | What it is, its model, where it lives (channels and projects, linked), what it may use (chips into Access), attention items (model unavailable, computer offline, mailbox suspended), recent activity | The identity block and the scattered health lines |
| Instructions | Instructions (`AGENTS.md`), manner (`personality.md`), its other documents (the agent's Documents space), checklists it can follow (to-do templates, including Repeat on a schedule) | Edit › Basics system prompt, Behavior › voice and manner, Documents tab, To-dos › Templates |
| Access | Grouped switches with one shape: Apps and accounts · Computers · Cloud browser (grant, sign-ins, reset) · Documents it can read or write · Email address (claim, send policy) · Research (DeepWater bundle) · Built-in tools (collapsed, by category). Owner-only rows say so. | Tools tab, Designer › Tools, App › Agents with access, mailbox "Agents with access", executor › Agents, Email tab, Tool detail › Agent access |
| Schedule | Everything that wakes it: schedules, intervals, board columns ("starts work when a ticket enters…"), document watches, webhooks, manual; each row Run now / Pause / Edit; health sentence and Reauthorize | Activity › trigger panel, the Triggers list filtered to this agent |
| Activity | Conversations (tickets and documents folded), to-dos, runs and failures, mailbox (link to the reader), helpers it spawned (only when any), tool log (collapsed, marked technical) | Activity, To-dos › instances, Sub-Agents, Messages, mailbox page |
| Settings | Model (with "Link your AI plan" and "Ask an admin to enable a model" doorways, local-model approval), effort, run limits in plain terms ("stop a task after N minutes or N credits"), voice, visibility (fixed after creation), ownership (transfer, take), to-dos on/off, delete | Edit › Model, Behavior › limits, ownership controls, Designer › To-dos |

The Design Assistant stays as a right-rail dock on every tab and as "Continue
in chat"; creating an agent keeps its Create (chat) and Configure modes, which
write into the same tabs.

**Apps.** The catalogue with two tiers. **Integrations**: a curated shelf of
the services corporate teams actually connect (Google Workspace, Microsoft
365, Slack, Jira, Linear, GitHub, Trello, and Nessie's own research service,
cloud browser and local AI), each a single page that knows every way it can be
connected and never shows a community duplicate beside a first-party sign-in,
laid out under the same purpose headings as the personal list (Mail and
calendar · Chat · Tickets and code · Browsers · AI).
**All apps**: the registry (about 6,400 entries) behind search, badged
Community, plus "Add a custom app". An app page: About · Connect ("for you",
"for a project or channel", "for the company", each in words) · Accounts
(who connected it, status, Reconnect, Disconnect, Connect another) · Agents
with access · and, for administrators, Review new capabilities and Lock.

**Computers.** All computers this person may use: Mine · Shared with me ·
Team's. Pair a computer (this computer, or with a code). A computer's page:
Overview (status sentence, what it offers, last seen) · Agents (whole-suite
grant, Add agent, Remove) · Sharing (a person: Can use / Admin; a project;
everyone in this team) · Activity (in use now with End, standing access with
End, coding sessions with view and share, changes to review, recent work). The
lifecycle (pause, resume, disconnect, delete, local models, on this computer)
stays in the "Computer" menu with its password or code confirmation.

**Automations.** Tabs Schedules & triggers · Batch jobs · Workflows. The first
is the current Triggers list with an agent and project filter, its editor and
detail unchanged in function (machine access included), and the raw JSON of
webhook and event triggers folded under "Advanced" inside the editor. Batch
jobs is Task Sets with a vocabulary pass ("processor model" → "runs on",
"receiver" → "hand results to", "journal" → "results"). Workflows is the row
that keeps its place for the other session.

### 6.4 Admin (rail item; administrators only)

Sidebar, in this order, with the audience each page shapes itself to:

| Page | Holds | Audience |
|---|---|---|
| **Overview** | Only things that need a decision, each a doorway: invitations waiting, agents whose schedule stopped, accounts needing sign-in, computers offline with standing access, credits low, models disabled but in use | Team and org admins; empty when nothing needs doing |
| **People** | The roster: name, email, organisation role, teams, status; filters by team and status; Invite (from the organisation, or by email, with team targets); a person's panel: role, teams, remove from team, deactivate or reactivate, AI on their own computer policy; tab Automatic team access (verified email domains) | Team admins see and act on their teams; org admins on everyone. On SSO installs every write is the relay; on a local install the local roster |
| **Teams** | Every team: name, address, picture, members, call provider; New team; a team's page: General (name, address, picture, call provider) and Overrides (AI models narrowed, AI on own computers, cloud browser account, keys) as links into the pages below filtered to the team | Org admins all teams; team admins theirs |
| **Organisation** | Name, logo, appearance (the organisation palette and its checks) | Org admins; owner for the palette if that rule stays |
| **AI models** | The live catalogue with "Available for new selections" switches (a disabled model keeps its pinned agents running, and the row says how many), Test (marked "spends credits"), bulk enable/disable with its blast-radius confirm; scope switch Organisation / each team (a team can only narrow); "AI on people's own computers" default with the team and person overrides listed | Owner for the organisation catalogue; team admins for narrowing |
| **Apps and accounts** | Company-level connections: shared mailboxes, company cloud browser, research service on/off per team, project and channel app installs (what is connected where and by whom), install policy and locks | Org admins; owner-only rows say so |
| **Keys** | One table of organisation and team keys with a Level column, Locked and Overridden chips, Add a key at organisation or team, Revoke, Revoked tab | Owner (writes are owner-only today) |
| **Usage and limits** | Usage in credits by team, agent and person for a period; budgets per organisation, team or project with three plain modes (Warn · Stop automations · Switch to a cheaper model) plus Unlimited, a period and caps; storage cap | Owner |
| **Credits and billing** | The billing service's own page: balance, buy, automatic top-up, statement, add-ons; present only when billing is configured | Members reach their projection under Your settings › Usage; managers here |
| **Security** | Audit log with the filters the API already has (who, what, outcome, date, project or team), an entry detail, export, and Verify integrity, which answers in a sentence ("All 12,431 entries verified, none altered"); programs signed in as people (org-wide list, revoke, Allow pairing) | Owner |
| **Advanced** (collapsed) | Tool registry (the current Tools page, JSON included); Access rules (the current Policy page, later a readable role matrix); Model pricing; Telemetry (token, connector and file breakdowns); System health; Mobile push setup; Session debug | Owner; instance operators for health and push |

Why these and not more: every page above answers a question an administrator
has ("who is in the company", "which models may we use", "what is connected",
"what are we spending"). Nothing is a list nobody opens. Credits and billing
and Usage and limits are two pages because the billing standard forbids
rendering the billing service's figures beside local telemetry.

### 6.5 Project settings

One Settings page with sections: General (name, description, picture,
visibility, which the API accepts but no screen offers today) · People ·
Boards (the list, with each board's own settings page unchanged) · Fields ·
Connected tools (sources) · Computers (machines shared with the project, with
"Share a computer" opening the computer's Sharing tab) · Archive or delete.
The Executors project section leaves the sidebar, because it was a read-only
list whose only action left the project; the Overview tile blurbs are written
from what the sections actually hold; the two overview routes become one.

### 6.6 Conversation settings

One "Details" panel for every conversation, opened by the gear, by the members
count and by the three `/info` routes (which stay routes for Back and deep
links): General (name, topic, description, visibility) · People (add, remove;
the one line that says an administrator adds agents) · Agents (place, remove,
the Personal Assistant presence) · Notifications (mute) · How agents respond
(the decision policy, kept whole but under a name a person can read) ·
Automations. The Automations and Agents tabs on the conversation itself stay
as content tabs.

### 6.7 The connection model

Four nouns, three verbs, one grant.

- An **account** is a login at another service. It belongs to a person or to
  the company. Google, Microsoft, Slack, Jira, Linear, GitHub, Trello, an email
  provider over IMAP, an AI plan, a cloud-browser key, a shared mailbox.
- An **app** is a capability package from the catalogue. Connecting an app
  creates an account at a scope: for you, for a project or channel, for the
  company.
- A **computer** is a paired machine, owned by the person who paired it,
  shared with people, projects or the team.
- A **key** is a saved credential in the vault.
- **Connect** makes an account or pairs a computer. **Share** widens who may
  use a computer. **Allow** is the one grant: which agents may use this
  account, app or computer. It is the same component on every object page and
  the mirror of the agent's Access tab.

What this does to today's fourteen kinds: comms connections, Google scopes,
IMAP mailboxes, AI-plan subscriptions, the cloud-browser key, project-tool
connections and person-scope app instances are all *accounts* in one list with
one status vocabulary; standing send grants and Google capability permissions
are sections on the Google account's page; DeepWater is the research
integration's page with its team switch; local Ollama is a capability of a
computer; the paired-agent credential is the inverse direction and lives under
Security as a program signed in as you; the vault stays the vault, named Saved
keys, and every "paste a key" box in the product becomes the same "Add a key"
dialog that saves there (§10).

Three details borrowed from the Codex run make the model answer the question
people actually ask. An account's page has a **Used in** section (the agents,
projects, automations and browsers that depend on it), so revoking is never
blind. Finishing a connection says what is still missing ("Connected. Choose
which shared agent may use this mailbox."), never a bare green tick. And both
the account page and the agent's Access tab offer **Check access**: pick an
agent and a context, and the server answers each step in words (signed in,
provider permits reading, folders selected, agent allowed, this request may
use Maya's account, sending needs approval) with one authorised remedy per
failure. That is an API (§10), not a client-side guess.

The Google Workspace page, concretely: "Sign in with Google" with the four
capabilities as checkboxes (read mail, send mail, calendar, meet), then a
Permissions section to widen or block one at a time, then "Let an agent act
without asking" as today, then "Other email provider (IMAP)" as the fallback
for an address Google does not serve. The community "Gmail" MCP server is
still installable from All apps, badged Community, with a line pointing at the
integration.

### 6.8 The scope pattern

Any page whose data exists at organisation and team level (AI models, Keys,
Apps and accounts, People) gets one scope switch at the top, "Organisation ·
Design · Sales", and shows inheritance on the row: "Set by organisation" as a
chip, "Locked" with the level that locked it, "Overridden by this team". A
locked control is present, greyed and inert, and says who can change it, which
is the existing `ScopedSettingGate` behaviour applied uniformly. The team page
never re-implements a setting; it links into these pages with the team
preselected.

Two rules travel with the switch, both from the Codex run. A write always
names its target in the header and in the URL, and a missing or unknown team
is an error, never a silent fall-back to the first row or to the session's
ambient team. And a list is never narrowed to the active team by default: it
shows what the person is entitled to see, with explicit Team, Project and Mine
filters, which is Rule zero's second check.

### 6.9 Page anatomy and consistency rules

- Header: title, an eyebrow naming the section, at most one primary action.
- One tab strip at most, at most six tabs, tabs in the URL as today. A page
  with fewer than three concerns has no tabs, only sections.
- Sections are flat groups separated by dividers. A card never holds a card.
- Tables are the shared `DataTable` with the shared footer.
- Status is a sentence from one vocabulary: **Connected · Needs attention ·
  Turned off · Not finished · Error**, each followed by the remedy where there
  is one.
- Empty states name the next step and link to it.
- No identifier, hash, JSON or raw enum outside Advanced.
- Every object page (agent, app, account, computer, person, team) is reached
  from every row that names it, and every "N agents" or "N accounts" count is
  a link.

## 7. Vocabulary

| Today | Proposed | Note |
|---|---|---|
| Admin (rail, for everyone) | Your settings (avatar) and Admin (administrators) | D1 |
| Executor, machine, governed sandbox | Computer | "Sandbox" as a badge on a guest runtime |
| Pair an executor | Pair a computer | |
| Paired agents, MCP client | Programs signed in as you (personal), Programs signed in as people (admin) | |
| Secrets, secret key, reference, precedence | Saved keys, key, (reference shown only on Copy), Where it comes from | |
| Connected accounts | Connected accounts | Broadened to every account |
| Apps, App Store | Apps, with Integrations and All apps | |
| Tools (registry) | Tool registry (Advanced); on an agent, Built-in tools | |
| Triggers | Schedules and triggers | "Trigger" stays for webhooks and events |
| Task Sets, processor, receiver, journal | Batch jobs, runs on, hand results to, results | |
| Models, AI inference provider | AI models | |
| Personal model subscriptions | Your AI plans | |
| Local Ollama, local inference host, binding | AI on your computer, AI models on this computer | |
| Cloud browser, Browserbase | Cloud browser | Vendor named once in help text |
| Credits & billing | Credits and billing | One capitalisation |
| Operational usage | Usage and limits; Telemetry (Advanced) | |
| Policy, Policy Rules | Access rules (Advanced) | |
| Health, System Health | System health (Advanced) | |
| Push credentials | Mobile push setup (Advanced) | |
| Statuses | Status | |
| Members (×2) | People | One page |
| Organisation / Organization | Organisation | One spelling in every label |
| Automatic logins | Automatic team access | Its own lede already denies "login" |
| Workspace, tenant, UOA, UnlikeOtherAI | your sign-in provider | Only in help text |
| Infisical, Ledger, Kelpie, MCP, IMAP, SMTP, OAuth, cron, JSONL | never in a label | Help text only where a person must act on it |
| Use this everywhere (a lock) | Prevent overrides below, naming the scope | A lock that reads as sharing |
| Revoke (a session) | Sign out this device | Revoke stays for credentials |
| Team-owned | Managed by the team ("anyone who can open it can edit it") | The consequence is the point |
| `needs_reauthorization`, `personal · active`, `pending_setup` | a sentence | R5 |

## 8. Where every current function goes

Every control the audits found, by today's surface, and its new home. "Same"
means the function is unchanged and only moves. Rows marked *held back* are
functions with no consumer today (§9).

### 8.1 Shell and navigation

| Today | New home |
|---|---|
| Rail Admin → `/settings` → own Profile | Rail Admin (administrators only) → Admin › Overview; Profile → avatar › Your settings |
| Team switcher: switch org+team, Invitations with Accept, Add team (tab New organisation) | Same switcher; "Organisation › Team" as text on desktop; Add team → Admin › Teams › New team; Create an organisation… its own row and dialog |
| Avatar menu: Availability, Status, Executors rows, Feedback, Debug, Account settings, Log out | Availability, Status, Your settings, Admin (entitled), Send feedback, Sign out; Debug → Advanced › Session debug; computers → Your settings › Your computers |
| Create menu: Message, Channel, Project, Agent | Same |
| Alerts bell, `/alerts` page (Unread only, Mark all read, Accept invitation) | Same, and the bell added to phone home header, native roots, and kept visible in focus mode with a muted style |
| `/feedback` (Send feedback, Your feedback list, GitHub issue link) | Avatar › Send feedback (same page, eyebrow removed) |
| `/mail` reader and composer | Same; doorways from the account row's Open mail |
| Full refresh (native) | Native avatar menu only |
| Legacy redirects (`/workflows`, `/chats`, `/work`, `/settings/tools|agents|profile|security|notifications|appearance|agent-access`) | Kept, plus one redirect per route renamed by this plan |

### 8.2 User group

| Today | New home |
|---|---|
| Account › Profile: photo upload and crop (SSO relay or local), name, email, organisation, team, provider, Sign out | Your settings › Profile (same; teams listed with Switch; Sign out kept) |
| Account › Profile: Session ID, Issued, Auto redirect | Your settings › Security › This device (session id and issued); Auto redirect → Advanced › Session debug |
| Account › Agents: cloud browser connect / replace key / reconnect / disconnect, home page, lock gate | Your settings › Connected accounts › Cloud browser row and its page |
| Account › Agents: Your browser sign-ins | Same row's page, "Signed in to", with Reset linking to the agent's Access tab |
| Account › Notifications: focus mode, push, notify me about (6), quiet hours, browser notifications, muted channels | Your settings › Notifications (same; Budget alerts owner-only; muted list shows muted only) |
| Account › Appearance: theme, text size, app icon | Your settings › Appearance (same) |
| Account › Security: active sessions with Revoke, password change (local) | Your settings › Security (same) |
| Secrets: Active/Revoked, table (key, reference, scope, precedence), New secret (personal or project, Use this everywhere), Revoke | Your settings › Saved keys (same table; Add a key; "Where it applies") |
| Connected accounts › Email: comms table (account, status, provider, last synced) | Connected accounts list rows for Google and Microsoft |
| Connected accounts › Email: Acting on your behalf (edit boundary, revoke, counts) | The Google account page › Acting on your behalf (same; also shown when empty, as "Nothing yet") |
| Connected accounts › Email: Live IMAP mailboxes (Open mail, Test, Disconnect, Agents with access switches) | Connected accounts rows badged Live mailbox; Agents with access on the row's page and mirrored on each agent's Access tab (one switch, not two; see §10) |
| Connect email / Connect mailbox ladder (address, provider rows, app password, server, leg, manual) | Same ladder, opened from Connect an account › Other email provider, or from the Google/Microsoft page when the address is not served |
| Connected accounts › AI inference provider: subscriptions (Link, key or device code, confirm account, Disconnect) | Connected accounts › Your AI plans rows (same dialogs) |
| Connected accounts › AI inference provider: Find Ollama on this computer, host status, parallel requests, pause/resume/disconnect local models | Your settings › Your computers › the computer's page › AI models on this computer (same controls) |
| Connected accounts › Slack: Connect Slack, table | Connected accounts › Slack row |
| Connected accounts › Calendar & Meet: capability picker, Continue with Google | The Google Workspace page › Connect with capabilities; Permissions section to widen later |
| Connected accounts › Project tools: Connect Jira/Linear/Trello/GitHub, Reconnect, Remove | Connected accounts rows; "Use in a project" doorway to the project's Connected tools |
| Connection detail: Open mail, Resync, Disconnect, Delete imported data, Imported history, Last sync, Granted permissions, Included resources | The account's page › Status and data (same) |
| Connection detail: Permissions (Grant / Ask again / Block / Unblock per capability) | The account's page › Permissions (same) |
| Connection detail: Let an agent act without asking (agent, mode, boundary) | The account's page › Acting on your behalf › Add (same) |
| Connection detail: Manage channels & labels (Include switches) | The account's page › Included channels and labels (same) |
| Paired agents: Pair an agent (code, scopes, warning, Allow / Don't allow), table, Revoke, detail, `?code=` | Your settings › Security › Programs signed in as you (same dialog and deep link) |
| Statuses: New status (icon, label), table, Clear active, detail: Set active, Delete, icon, label, schedules (weekly, date range, timezone) | Your settings › Status (same; timezone becomes a picker) |
| Statuses: Enable response agent, Agent instructions, Contact rules | *Held back* until dispatch reads them; return as "Out-of-office assistant" on the Status page |

### 8.3 Team group

| Today | New home |
|---|---|
| Team › Settings › Profile: team name (SSO relay), team address, team avatar, team picker | Admin › Teams › [team] › General (same; every team editable from its own page, so the picker goes) |
| Team › Settings › Agents: team cloud browser, Allow local Ollama | Admin › Apps and accounts (scope: team) and Admin › AI models (scope: team); linked from the team page › Overrides |
| Team › Models: filters, Enable/Disable all matches, table with Test and Available | Admin › AI models with the scope switch on the team |
| Team › Secrets: table, New secret, Revoke | Admin › Keys (Level column) |
| Team › Members: Active / Pending / Deactivated / Automatic logins, Invite people (from organisation, by email), member details (role, Remove from team, Deactivate in organisation), invitation details (Resend, Cancel, approval state) | Admin › People filtered to the team; Automatic team access tab; the person's panel |
| Team › Members on a local install (role select, deactivate, remove, invite, approve/deny) | Admin › People, local mode (same functions, rendered by the local roster instead of the SSO relay) |

### 8.4 Organisation group

| Today | New home |
|---|---|
| Org › Settings › Profile: name (SSO relay), logo | Admin › Organisation |
| Org › Settings › Agents: call provider per team | Admin › Teams › [team] › General › Call provider |
| Org › Settings › Agents: shared mailboxes (connect, test, disconnect, agents with access) | Admin › Apps and accounts › Shared mailboxes (same rows and grant) |
| Org › Settings › Agents: company cloud browser | Admin › Apps and accounts › Cloud browser (company) |
| Org › Settings › Appearance: light/dark, accent, background, sidebar, checks, Save/Remove theme | Admin › Organisation › Appearance |
| Org › Models: catalogue, Test, bulk, Local Ollama policy and lock | Admin › AI models (organisation scope) |
| Org › Secrets | Admin › Keys |
| Org › Paired agents: Allow pairing, org-wide table, Revoke, detail | Admin › Security › Programs signed in as people |
| Org › Members: roster, organisation role, team access, per-person Local Ollama, invite with team targets, automatic access | Admin › People (organisation scope) |
| Org › Members on a local install: Owner/Admin/Member/Viewer, Deactivate, Add member with password | Admin › People, local mode (Viewer kept only if the API honours it, §12) |
| Platform › Push credentials (APNs, FCM) | Admin › Advanced › Mobile push setup |

### 8.5 Agents group

| Today | New home |
|---|---|
| Agents list: Personal / Shared / Global tabs, New agent, delete with confirm, Repair link, Open private home, owner cell | Agents › Agents: Mine / Shared / Built-in (same) |
| Agent header: avatar quick edit (generate, upload, crop, remove), status pill, Stop, ownership Transfer / Take | Agent page header and Settings › Ownership (same) |
| Edit tab › Basics: name, role, visibility, system prompt, parent | Instructions (prompt) and Settings (name, role, visibility) |
| Edit tab › Model: combobox (computers, plans, hosted), Link a personal subscription, Organisation models link, Approve local model, Check executor approval | Settings › Model (same) |
| Edit tab › Behavior: reasoning effort, run limits (tokens, tool calls, steps, minutes, cents), voice, manner | Settings › Effort and limits (plain units), Settings › Voice; manner → Instructions |
| Edit tab › To-dos switch | Settings › To-dos |
| Designer › Tools (create only) | Access tab, available at creation too |
| To-dos tab: templates (new, edit, archive, Repeat on a schedule), instances (new, Run now, cancel, step status, open thread) | Instructions › Checklists (templates, Repeat on a schedule creates the interval row on Schedule); Activity › To-dos (instances) |
| Activity: conversations, current activity, trigger panel (New, Run now, Pause, Resume, deliveries), run failures, tool execution log, thought stream | Activity (conversations, runs, failures, tool log collapsed); Schedule (triggers); thought stream removed |
| Sub-Agents tab | Activity › Helpers it spawned, shown only when non-empty |
| Tools tab: picker with categories, Save, browser card (open now, sign-ins, import, reset), protected grants owner-only | Access (same grants, grouped by kind) |
| Messages tab | Activity › Details (collapsed) or removed (§12) |
| Documents tab: Knowledge workspace on the agent's space, core-doc notice | Instructions › Documents |
| Email tab: claim address, send policy, Open mailbox, Delete mailbox | Access › Email address |
| Design Assistant dock, Continue in chat, Create/Configure modes | Same |
| Agent mailbox page: filters, thread list, reading pane | Same page, from Activity › Mailbox and Access › Email address |
| Task Sets: list, form (work, processor, input, output, receiver), detail actions (start, resume, retry, pause, cancel, add item, refresh), items (retry, skip, edit), local host controls | Agents › Automations › Batch jobs (same, renamed fields) |
| Triggers list: tabs, search, type filter, table, New trigger, `?create=` | Agents › Automations › Schedules and triggers (same, plus agent and project filters) |
| Trigger editor: type picker, target, agent, channel, workflow, schedule / interval / webhook / event / ticket / document fields, description, Enabled | Same editor; JSON and header fields under an Advanced fold inside it |
| Trigger detail: Run now, Reauthorize, Pause/Resume, Edit, Delete, health banner, facts, machine access (set up, card, confirm, End), webhook endpoint, deliveries | Same page; also summarised on the agent's Schedule tab |
| Tools list: source tabs, search, status, tags, review bar (Approve / Disable selected) | Advanced › Tool registry (same); connector review also on the app's page › Review new capabilities |
| Tool detail: id, scope key, version, schemas, transport, Review, Agent access panels | Advanced › Tool registry (same); per-agent access mirrored on Access and the app page |
| Executors list: table, Pair executor (this computer, code, review, confirm), Sessions, Manage apps, Reviewed drafts, intents (`?create`, `#confirmationToken`, `?accessChange`, `?promotion`) | Agents › Computers (same table and pairing; Sessions → Computers › Sessions tab; Reviewed drafts → the computer's Activity › Changes to review; Manage apps removed, Apps is one click away) |
| Executor detail: Machine menu (on this computer, local models, pause, resume, disconnect, delete with confirm), Agents (add, remove, capabilities), Sessions (local apps, device inventory, coding sessions, view, close), Permissions (team switch, people, projects), Activity (leases, standing access, recent sessions) | Computer page: Overview, Agents, Sharing, Activity (sessions folded in), the same menu |
| Executor sessions page and session viewer (terminal, share with a viewer) | Agents › Computers › Sessions (same) |
| Run on an executor launcher and lease chip (chat) | Same; copy rewritten in plain words |
| Apps: search, All / Installed, categories, card states, Connect dialog (scope Just you / A channel / A project), progress, Add an API key (personal / shared), custom app, detail tabs (Overview, Capabilities, Connected accounts, Agents with access), DeepWater Turn on / Update / Turn off | Agents › Apps: Integrations shelf and All apps; the same connect, key and progress dialogs; the app page (About, Connect, Accounts, Agents with access, Review, Lock); research integration page carries the team switch |

### 8.6 Governance and Platform

| Today | New home |
|---|---|
| Credits & billing: balance, added/used/pending, View statement, Buy credits, automatic top-up dialog, credits by service, recent activity, Your plan, Upgrade plan, add-ons subscribe / cancel, statement (line items, usage tabs, actions, cancellation dialog) | Admin › Credits and billing (manager projection) and Your settings › Usage (member projection); Compare plans and the seats row removed |
| Operational usage: group select, tiles, breakdown, spend by outcome, file usage, connector usage | Admin › Usage and limits shows usage by team, agent and person in credits; the rest → Advanced › Telemetry |
| Budgets: scope, mode (Off/Warn/Enforce/Degrade/Unlimited), period, storage cap, cost cap, token cap, warn at, block people's requests, fallback model, list with Edit / Delete | Admin › Usage and limits › Budgets (same fields; modes renamed Warn · Stop automations · Switch to a cheaper model · Unlimited; "also stop people's requests" as a checkbox under Stop automations) |
| Model pricing: provider, pattern, four rates, Save, list, Delete, Re-price historical usage | Advanced › Model pricing (same) |
| Audit log: Filter by action, rows | Admin › Security › Audit log with who / what / outcome / date / project or team filters, entry detail, export, Verify integrity in words (all already in the API) |
| Policy: Create rule (resource, action, effect, actor id), rules list, Delete | Advanced › Access rules (same; "Actor ID" relabelled Role); a readable role matrix later (§12) |
| System health: worker, queue, dead-letter jobs and messages, rate limiting, Refresh | Advanced › System health (same) |
| Alerts, Feedback | §8.1 |

### 8.7 Project and conversation

| Today | New home |
|---|---|
| Edit project dialog (name, description, picture), Rename & icon | Project › Settings › General (with visibility) |
| Members button and dialog | Project › Settings › People (button kept in the header) |
| Boards list, New board, board settings (General, Columns, Watchers, Labels) | Project › Settings › Boards (list); board settings unchanged |
| Settings › Fields, Sources (connect, mapping, sync, pause, remove) | Project › Settings › Fields, Connected tools (same) |
| Executors section, Share an executor | Project › Settings › Computers |
| Delete project (sidebar menu) | Project › Settings › Archive or delete |
| Overview twice (`/projects/:id`, `/channels/projects/:id`) | One route; the Channels sidebar links to it |
| Channel settings dialog (name, topic, description, archive, delete; Agent decisions) | Conversation › Details › General and How agents respond |
| Members popup (people add/remove, agents view/copy/remove, Personal Assistant presence) | Details › People and Details › Agents |
| Conversation info flow (messages, files, members, add people, mute) | Details (the same routes render its sections) |
| Automations tab, Agents tab | Same tabs; Details › Automations lists the same installations |
| Knowledge space settings (name, description, visibility, restrict editing, people, agents) | Unchanged; the visibility words align with §7 |

## 9. AI-slop candidates and what to do with each

"Slop" here means a surface that answers no question a person has, or that
exists because a feature was built before its consumer. Each row says whether
anything depends on it and what to do.

| Surface | Depends on it | Disposition |
|---|---|---|
| Statuses › response agent, agent instructions, contact rules | Nothing reads them (`docs/functionality.md` says dispatch does not evaluate them) | Hide until dispatch consumes them; then return as "Out-of-office assistant" |
| Profile › Session card (Session ID, Issued, Auto redirect) | Support diagnostics only | Move to Security › This device and Advanced › Session debug |
| Credits & billing › "Nessie Team seats · Needs backend · Manage seats" | Nothing | Remove until seats exist |
| Credits & billing › Compare plans (runs Upgrade) | Nothing | Remove |
| Agent › Thought stream placeholder | Nothing | Remove |
| Agent › Sub-Agents "team members" | Spawned helpers are real but unreaped | Show under Activity only when non-empty |
| Agent › Messages tab (raw role dumps) | Duplicates Conversations | Collapse into Activity › Details or remove |
| Tools registry as a sidebar item (ids, scope keys, JSON schemas, transport) | The review half is load-bearing (connector tools are inert until approved; protected grants have one writer) | Keep whole under Advanced; surface the review on the app page |
| Tool grants written by `ToolAgentAccessPanel` for ordinary tools | The worker never reads `ToolGrant` for exposure | Remove the switch for ordinary tools; keep explicit-grant switches |
| Policy Rules page | The engine is load-bearing (API default-deny); the page can break an organisation with two clicks | Advanced; label Actor ID as Role; block deleting seeded rules that do not self-heal; later a readable matrix |
| Operational usage tiles: Monthly projection, Spend by run outcome, File transfers, Connector usage | Read-only; drive nothing on the page | Advanced › Telemetry |
| "Internal operations only" and statement architecture notes addressed to developers | Nothing | Remove; the two-page split says it |
| Twelve built-in themes | A real preference; High Contrast is an accessibility need | Decision (§12): keep Light, Dark, System and High contrast plus the organisation palette; the other eight are demo-ware |
| Estimated cost that reads $0.00 until an owner types per-model prices | Budgets in money depend on pricing | Seed pricing from the model service's published rates (§10); label every figure "estimated" |
| Executors header: Reviewed drafts, Manage apps, Sessions; "governed sandboxes" copy | Drafts and sessions are load-bearing for developers | Move into the computer's Activity and a Sessions tab; rewrite the copy |
| Executor run launcher copy ("shell-free argv command", "copy-on-write") | Load-bearing doorway | Rewrite in plain words |
| Raw statuses (`needs_reauthorization`, `personal · active`, `pending_setup`) | Nothing | Sentences (R5) |
| Webhook and event trigger raw headers, API keys, JSON filter | Load-bearing for integrators | Advanced fold inside the editor |
| Three "Agents" settings tabs holding cloud browser, Ollama and mailboxes | The settings are real | Dissolve into Apps and accounts and AI models |
| Team › Settings with one field | Real field | Dissolve into Admin › Teams |
| Muted channels listing every private conversation with a raw visibility word | Real preference | Show only muted rows with Unmute |
| Debug (session debug) in every avatar menu | Support only | Advanced |
| Global agents tab whose rows open a disabled form | Real rows | Built-in tab with a Provided-by-Nessie note and only working tabs |
| Two project overviews | Real page | One route |
| Calendar & Meet tab with no list; duplicate email lists with two vocabularies | Real connections | One account list (§6.7) |
| "Automatic logins" | Real feature | Rename |
| Feedback eyebrow "General" | Nothing | Remove |
| `/api/triggers/upcoming` (returns overdue, no consumer) | Nothing | Delete, per the 2026-08-11 decision record |
| Project › Executors section | Read-only list | Settings › Computers |
| Insights as a project section | Two charts, scrum only | Keep as a board feature; not admin, not slop |
| Task Sets | A real batch product | Keep as Batch jobs; vocabulary pass |
| Paired agents | Real security feature for developers | Keep under Security; corporate users never see the word MCP |

## 10. API and process changes this needs

The user's brief allows process and API change. These are the ones the
architecture above actually requires; everything else is presentation.

1. **One accounts read model.** `GET /api/accounts?scope=me|team:<id>|organisation`
   projecting comms connections, IMAP mailboxes, project-tool connections,
   AI-plan subscriptions, cloud-browser connections and person-scope app
   instances into one row shape: service, owner, scope, status (the five
   words), capabilities, agents with access, actions. The existing tables stay;
   this is a projection plus a shared status mapper, so the UI has one list.
   Until it lands, the same union can be assembled in the client from the
   existing reads with the same status mapper, which is where the kimix
   proposal suggests starting.
2. **One grant write.** `PUT /api/accounts/:id/agents/:agentId` that fans out to
   whichever grant table applies (mailbox access rows, app policy targets,
   executor operation grants), so "Agents with access" is one component. The
   mailbox's double switch becomes one: granting access on the account also
   turns the agent's mailbox tools on, since the second switch had no
   independent meaning.
3. **One key store, eventually.** Every "paste a key" dialog saves into the
   vault and hands the connector a reference. The secret-management spec
   already names the connector stores as a legacy split. Until the backend
   lands, the four dialogs share one component and one wording.
4. **People read model with teams.** `GET /api/people?team=<id>` returning the
   organisation roster with each person's teams and role, relayed from the
   sign-in provider on bound organisations and read locally on unbound ones,
   with team-scoped actions authorised per target as today. This also fixes the
   local-install Team › Members page, which currently renders the SSO relay.
5. **Teams as an admin object.** List, create, rename, address and picture
   through the existing provisioning and relay routes, from one page.
6. **AI models in one shape.** One read returning the organisation catalogue
   with per-team narrowing and the own-computer policy at each level, so the
   scope switch is a filter and not a second page.
7. **Project visibility editable.** `PATCH /api/projects/:id` already accepts
   it; the settings page exposes it.
8. **Audit log filters, detail, export, verify** are already routes; expose
   them.
9. **Budget alerts as an alert kind**, so the bell shows them; the once-per-
   transition rule is unchanged.
10. **Navigation contract.** One new section id (`agents`), `admin` shaped by
    entitlement, one redirect per renamed route, and a coordinated native
    shell release for the tab bars.
11. **Deletions.** The seats section and its comment, Compare plans, the
    thought stream, the ordinary-tool grant switch, `/api/triggers/upcoming`.
12. **Seed model pricing** from the model service's published rates so an
    estimate is never $0.00 by default; an owner's override still wins.
13. **Effective access explanation.** One read that composes the real
    provider, account, grant, context and policy evaluators for a named agent
    and context into ordered steps, each with a structured reason and one
    authorised remedy, and whose refusal details carry no protected data.
    This is what Check access (§6.7) renders.
14. **Expose what exists and reconcile what disagrees.** The catalogue lock
    and unlock routes have no control in the admin today; they become the app
    page's Lock. The budget resolver's order and the budget form's copy
    disagree with the documented organisation → team → project; reconcile the
    resolver, its tests and the copy before the scope switch presents one
    hierarchy.

## 11. What must not change

Every constraint below is honoured by §6; a design that broke one would be a
defect, not a simplification.

- The sign-in provider owns identity, organisation and team structure,
  membership and invitations; Nessie relays writes with a per-request subject
  assertion and stores no second copy. People and Teams pages are relays on
  bound organisations. A team is a UOA team; a project is Nessie's own and
  lives in exactly one team.
- Secret values never display; the cascade is one pure function shared by the
  screen and the write; a lock above greys and names its level; organisation
  and team writes are owner-only.
- Settings that exist at several levels resolve organisation → team → person
  through `ScopedSetting`, and the lock is visible and inert where it binds.
- Installing an app is not granting it: connector tools are off per agent until
  granted; shared installs stay pending until an owner approves; protected
  built-in grants are written only through the registry writer.
- Per-(connection, agent) access rows for mailboxes, every mailbox send
  approved, no standing mailbox grants; Gmail standing grants exact-key,
  owner-only, never unattended.
- Approvals are answered on a card in the conversation they came from; there is
  no list of them, and this plan adds none.
- Billing is authoritative in the billing service, rendered from its own
  display models, never beside local telemetry (two pages, §6.4).
- Computers pair with two-half fingerprint confirmation; lifecycle and access
  changes are prepared and then confirmed with a password or emailed code;
  reach into a run is opened only by a person; standing machine access is the
  trigger author's card with End.
- An agent's local model needs device-side approval and never falls back to
  the cloud; the own-computer policy is a scoped setting.
- Ownership decides edit rights field by field; visibility is fixed after
  creation; a private agent is its owner's alone.
- Model availability is the live catalogue plus an exception list; a team only
  narrows; the picker and the write-time validator both enforce; Test spends
  credits and says so.
- Every route keeps a surface-registry row; Back, deep links and the phone
  stack derive from it; `ScreenHeader` publishes the one title.

## 12. Decisions still owed

1. **Rail names.** Keep Channels and Knowledge, or rename to Chat and
   Documents in the same release? The section ids can stay either way.
2. **Team administrators in Admin.** The proposal shows the Admin rail item to
   team administrators with their pages scoped to their teams. The
   alternative, org admins only, leaves team admins managing members from a
   team page under Agents, which is the mixing this plan removes.
3. **The vault as the one key store** (§10.3) is the largest backend item; it
   can follow the UI unification by one release.
4. **Messages tab**: collapse or delete.
5. **Viewer role** on local installs exists on one page only; keep only if the
   API honours it.
6. **Instance-operator pages** (System health, Mobile push setup): stay under
   Advanced or move to a separate operator console outside the tenant admin.
7. **Statuses' out-of-office assistant**: build the consumer or delete the
   fields.
8. **Budgets beside billing or beside usage.** The kimix run makes Budgets a
   second tab of Billing ("a money control beside the money"); this plan keeps
   it with Usage and limits because budgets are enforced in local currency and
   tokens while billing is in the billing service's credits, and the two must
   not read as one ledger.
9. **Trim the theme list** to Light, Dark, System and High contrast plus the
   organisation palette.
10. **When to rename Task Sets.** This plan calls them Batch jobs now; the
    Codex run argues the name should wait for the workflow session that
    reviews how task sets, to-dos, triggers and workflows relate. Either way
    the row keeps its place under Automations.

## 13. Rollout order

Each step ships whole, with its redirects and its browser suite, in this
order, because each one removes a class of confusion on its own:

1. Vocabulary pass and the avatar split: rename labels (§7), move personal
   pages under the avatar, hide the Admin rail item from members, land admins
   on Overview. No data changes.
2. Agents as a rail section: Agents, Apps, Computers, Automations; the agent
   page's six tabs; Alerts on every shell.
3. Connected accounts and the accounts read model (§10.1, §10.2); the
   Integrations shelf; the Google, Microsoft, Slack and Jira pages.
4. People, Teams, AI models and Keys with the scope switch; the local-install
   roster fix.
5. Advanced group; Usage and limits; Security with the audit filters; the
   deletions in §9.
6. Project and conversation settings consolidation.

### 13.1 Validation before a step is called done

Every step ships with the repository's headless browser checks, and the
structure itself is tested with people who have never written software, using
single-decision probes rather than a workflow walkthrough. The Codex run
proposed the probes; the target is that eight of ten participants pick the
right first destination, and that no probe ends with a misunderstood audience
or payer.

| Probe | Success |
|---|---|
| "Where would you connect your work calendar?" | Chooses Connected accounts without visiting AI models, Tools or Organisation |
| "Is this your account or a shared one?" | Names the identity and the audience from the account page |
| "Why can this agent not use this mailbox here?" | Names the missing step and who can fix it, from Check access |
| "Does turning this model off stop agents already using it?" | Says no, and finds the agents still pinned to it |
| "Which team will this setting affect?" | Names the target before Save, also after reloading a deep link |
| "Who pays if you pick this AI plan?" | Distinguishes personal from organisation funding |
| "Will disconnecting delete the imported email?" | Distinguishes Disconnect from Delete imported data |
| "Can an organisation owner see your private agent?" | Says no |
| "Which page changes your photo, and which the company logo?" | Your settings › Profile versus Admin › Organisation |
| "What is a program signed in as you, compared with an agent or a computer?" | Explains the three without protocol words |

## 14. The parallel model runs

Two other models were given the identical brief in parallel, each in its own
worktree, to look for ideas worth borrowing.

- **Kimi K3 (kimix)**: the first run read files for its whole budget and wrote
  only an outline. A second run, given the inventory inline and told to write
  the draft as its first action, produced a full proposal. It converges with
  this plan on every structural point: personal settings behind the avatar
  ("My settings") and an administrators-only section ("Workspace"); one page
  per concern with a scope switch and visible locks; one Connections section
  with one row per service and one status vocabulary; a search-first app
  directory with a dozen curated tiles; an Overview as the admin landing; the
  audit log's existing filters and verifier exposed; a guided policy editor
  with protected seeded rules; Task Sets as "Batch jobs"; statuses trimmed to
  what is consumed; the seats row and the Session card removed. Borrowed into
  this plan: grouping connections by purpose (mail and calendar, chat, tickets
  and code, browsers, AI), a client-side union as the interim before the
  accounts projection, a Verify-integrity action that answers in a sentence,
  seeding model pricing from the model service so estimates are never $0, and
  the observation that twelve built-in themes are demo-ware. Where it
  differs: it files Triggers and Task Sets under Advanced (this plan keeps
  schedules on the agent, because "when does it run" is a mainstream
  question); it makes Budgets a tab of Billing (§12); and it keeps paired
  computers an admin page rather than part of a section for everyone.
- **Codex (`gpt-6-astra`)**: the first attempts could not authenticate from
  this machine (the CLI on the path was too old for the model, and the newer
  one failed its websocket transport and then answered 401); a later retry
  signed in cleanly and the run produced a 100 KB report in about twenty
  minutes. It converges with this plan and the Kimi run on the split:
  personal settings behind the avatar; a section it calls Manage holding
  agents, connections, computers, people and teams, automation, company
  settings, access and limits, and billing; an operator console for health
  and push; "external access" as the name for programs signed in as you;
  computers for executors; one Connections centre with Connected, Browse apps
  and External access tabs; and the same removals. Borrowed into this plan:
  the effective-access check as a server capability (§6.7, §10), the Used in
  section and the connect-completion sentence, the explicit-target and
  never-narrow-by-session rules (§6.8), "available for new selections" with
  the pinned agents counted, three copy fixes (§7), the budget-resolver
  contradiction (§10), exposing the catalogue lock, and the usability probes
  (§13.1). Where it differs: it refuses any Overview page and makes the
  Manage landing the directory itself (this plan keeps an Overview that shows
  only decisions and is empty when there are none); it keeps Task Sets,
  To-dos and Triggers under their current names until the workflow session
  (§12); it folds the audit log, models and budgets into one Access and
  limits page, where this plan keeps Security, AI models and Usage and limits
  apart; and it moves system health and push setup out of the tenant admin
  entirely, which this plan lists as a decision (§12).
