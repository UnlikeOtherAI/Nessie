# Executor sharing

The executor detail page owns **Agents**, **Sessions**, **Permissions** and
**Activity**. Its doorways are Agents → Executors, the account menu and the
project's Executors tab. Reuse these surfaces; do not add a review queue.

## Direct access

An executor belongs to the person who paired it. Pairing uses the current team
and starts personal; there is no organisation-wide grant or team selector in
this flow. The pairing owner remains an administrator. A connection belongs to
one team; distinct connections on a computer retain independent access.

**Agents** assigns or removes an eligible agent immediately. The server changes
its assignment, operation grants and logical tool policy in one transaction.
The acting person must manage the machine and have the existing authority over
the agent; private-agent visibility is unchanged. This action has no approval
continuation, password prompt or fresh-authentication code.

**Permissions** means sharing:

- A named person gets **Can use** or **Admin**. An administrator manages agents,
  sharing and the executor lifecycle. An ordinary user cannot administer it.
- A project grants its members use for work in that project. Project roles
  confer no executor administration.
- **Everyone in this team** grants use to the current team's members. There is
  one switch, with no list of teams and no selectable team role.
- Sharing with a project or the whole team also grants the team's administrators
  management access. They cannot see an otherwise personal executor merely
  because they administer the team. Organisation ownership alone grants no
  access to a personal executor.

All membership checks are live. Inventory and realtime presence share the same
entitlement; an ambient session team never hides an otherwise entitled machine.
The project page explicitly filters that inventory by project and whole-team
shares. Sharing candidates belong to the connection's team. Private projects
are offered only to their members. Removing access fences existing commands and
ends affected use; sharing and its audit event commit together.

## Machine capabilities and sessions

A correctly signed capability report takes effect immediately. There is no
machine-permission review, approval badge or second identity check. Local
configuration still determines which folders, programs and tools the daemon
actually offers. Signatures, monotonic revisions, connection fences and runtime
checks remain enforced. Replacing a report fences the previous runtime; changes
to a separately authorized ticket policy's pinned terms suspend that policy.

**Sessions** shows the local-app/coding-session view with links to live terminals;
the cross-machine Sessions page lists terminals the reader owns or can view.
**Activity** retains conversation leases, standing ticket access and recent work.
A grant to use or manage an executor does not grant access to someone else's
conversation or terminal contents. Existing session-sharing rules still apply.

Pause, Resume, Disconnect and Delete remain in the Machine menu. Destructive
lifecycle confirmations and separately authorized unattended ticket policies
are distinct from the removed machine-permission review.

## Contracts and migration

`GET /api/executors/:executorId/sharing?teamId=` reads the sharing list and its
eligible people/projects. `PUT` on the same path takes `{teamId, change}`;
`change.kind` is `person`, `project` or `team`. `PUT
/api/executors/:executorId/agents` takes `{agentId, state}` and applies it directly.
`GET /api/executors?projectId=` is the explicit project inventory filter.

The migration converts old project scopes into project shares and resolves old
organisation sharing through the stored pairing-team reference. An unresolved
organisation scope becomes personal, never a guessed team. Owners and granted
agents retain their assignments. A legacy owner assignment that was downgraded
to use regains administration under the ownership model. Previously disabled machine capabilities
become a paused executor, which can be resumed from the Machine menu; pending
capability reports become active. The retained protocol scope of these machines
is `private`; it no longer means that a machine has no sharing entries.

No daemon wire change is required: existing Linux, Windows and macOS executors
already understand an active signed report. Database tests cover direct roles,
project-only work, team administration, membership loss and tenant isolation.
Headless executor-detail and executor-agents evaluations cover the direct UI.
