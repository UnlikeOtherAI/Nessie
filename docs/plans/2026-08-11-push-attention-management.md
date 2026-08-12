# Push attention management

**Status:** implementation verified in source; production APNs credential uploaded and accepted by Apple; Android FCM configuration pending Firebase project files · **Date:** 2026-08-12

## Goal

Make the self-operated APNs/FCM path useful rather than merely configured:
every important event that creates work for a person must produce one durable
attention item, one correctly routed push when the person is not already at
that destination, and one visible count until the person has viewed the
relevant surface.

This change covers three user-facing attention sections:

| Section | Durable source | New attention event | Clears when the user views |
| --- | --- | --- | --- |
| Channels | `ThreadReadState` | New message or direct mention | The exact channel/thread (existing read path) |
| Assigned work | `UserAlert(kind=task_assigned)` | A reachable project task is assigned or reassigned to a different person | That project's Board |
| Project knowledge | `UserAlert(kind=knowledge_published)` | A page is published for people who can currently read its space | Its reachable Knowledge space/page |

Channel message counts remain the source for channel badges. A mention is a
channel message, so it is never added again to the app-icon total. The two new
alert kinds are the source for the Projects and Knowledge counts.

## Delivery contract

1. A source mutation, its recipient-specific `UserAlert` rows, and one
   idempotent `attention.dispatch` queue row per alert commit in **one database
   transaction**. A failed alert or queue write rolls back the source mutation;
   a failed delivery never does. The native knowledge-provider seam is extended
   so this holds for both direct publication and approval-effect publication.
2. Every assignment/publication produces a new immutable alert generation. The
   generation is unique at the durable layer, so retries do not duplicate a
   count. A fresh event for the same task or knowledge page retires its older
   unread generation before creating the replacement, while assign-away/
   assign-back and unpublish/republish correctly create a fresh unread event
   rather than reviving an already-read row.
3. The delivery worker rechecks the recipient's current entitlement and
   preference, uses the existing encrypted APNs/FCM credentials and delivery
   audit, and never sends to an inactive member or token. Attention pushes
   carry their current durable attention count; channel counts retain their
   existing `ThreadReadState` source. The native bridge refreshes and projects
   the combined server state while the app is active.
4. The job has an exact structured surface, including the target identity:
   `{ kind: 'project_board', projectId }` or
   `{ kind: 'knowledge_space', spaceId }`. The heartbeat schema, presence
   table, API entitlement gate, route mapper, and worker matcher are all
   extended together. The shared Knowledge workspace reports its selected space
   directly rather than treating every Docs tab as one destination. A visible
   session suppresses only that exact destination.
5. Pushes contain only the necessary title/body and a deep link:
   `/projects/:projectId/board` for an assignment, or
   `/projects/:projectId/docs?spaceId=…&pageId=…` for a publication. They are
   coalesced by alert target and category.
6. Per-user controls default to enabled and gain two iOS-style toggles:
   **Assigned work** and **Published knowledge**. Existing master, message,
   mention, quiet-hours, and channel-mute rules continue to apply. This extends
   the shared preferences schema, merge request contract, worker preference
   kind map, and Settings UI together.
7. A live interactive agent turn notifies only its originating user when the
   reply becomes durable and they are no longer viewing that exact channel.
   Every terminal route (normal reply, reaction-only answer, cancellation,
   budget stop, error, and external-agent reply) shares one run-scoped queue
   idempotency key. A reply carrying a disclosure basis never exposes its text:
   dispatch rechecks the requester's live membership and grants against the
   stored basis, then sends only the generic “An agent reply is ready” body.

## Entitlement and read rules

`UserAlert` becomes the shared durable attention substrate already intended by
the existing mention implementation. New nullable target relations identify a
task, knowledge page, and project. Querying, counting, and sending an alert
must all revalidate it. This applies to the existing mention kind too, so a
revoked channel member never retains an alert title or unread count.

- A task alert is visible only while the recipient remains its current
  assignee and the task is actionable (not archived or terminal). It is created
  only for a project Board the assignee can reach: projectless tasks and
  assignments to non-project-members remain supported but deliberately produce
  no project-board alert until they have an owning surface.
- A knowledge alert is visible only while its page is published and the
  recipient still reaches the space under the same organization/project/explicit
  membership rule used by the knowledge reader. No alert title may survive a
  revoked space grant. Recipients without project navigation retain a global
  Knowledge doorway and its count; project rows and Docs tabs render only where
  the recipient can reach that project.
- Reading a Board or Docs route performs one scoped, recipient-owned `mark
  read` after that surface has loaded. The API selects the exact matching alert
  IDs and then writes only that server-side snapshot, never an unbounded
  category `updateMany`, so an alert committed while the request is in flight
  is not accidentally cleared even when a surface has more than one page of
  alerts. The summary also exposes a server-derived opaque version per project;
  it makes the client repeat that safe clear when new attention arrives while
  the Board or Docs surface remains open.
  It never marks another project or category read. Opening an individual alert
  uses the same endpoint for that one row. The legacy global "mark all" remains
  a deliberate user action only, never automatic routing behavior.
- `/alerts` and the alerts bell label each attention kind correctly and route
  it to its owning Board, Docs, or channel surface. An attention row is never
  marked read by a dead-end click.

The producer list is explicit and tested: `createHumanTask`, `assignTask`,
direct `publishPage`, and approval-effect publication. Board-move automatic
self-assignment deliberately produces no self-notification. No-op assignment,
assignment to the acting user, and publication to the acting user do not create
a self-notification.

## Display manager

The SPA has one `AttentionDisplayManager`, mounted in the authenticated shell.
It projects the existing channel unread state plus one server-owned attention
summary/facade; it does not create a second unread store. Private attention is
not relayed through a shared channel: that would expose the recipient and
category to other channel members. Active clients reconcile the lightweight
alerts and summary queries on a short interval, while the existing
channel-derived alert frames still invalidate immediately. It does three things:

1. Updates desktop/web project navigation: channel rows retain their existing
   badges; a project Board gets its assigned-work count and the Docs tab its
   published-knowledge count. The project-level row shows their sum so a person
   can find the project that needs attention. Global Knowledge shows accessible
   publication attention that has no reachable project row.
2. Bridges `{ channels, assignedWork, knowledge, total }` to the native shell.
   Native iPhone, iPad, and Android tab bars show the corresponding first three
   values. iOS sets its application icon badge to the server total. Android
   relies on its configured notification-channel badge; it does not claim an
   unsupported global app-icon setter.
3. When the app becomes active, or when the WebView reports a route change,
   native code dismisses already-present OS notification cards. That does not
   discard server-side attention: each category count remains until the user
   actually opens its matching surface, then server reconciliation reduces the
   web and foreground-native badges on active devices at their next short
   refresh. Background devices refresh the durable state when they next
   activate.

The manager is deliberately not a second unread store. It only projects the
server state into web and native presentation.

## Verification

- Unit/API tests: all named assignment/publication producers, transaction and
  outbox atomicity, idempotent generations, no self-notification; revoked
  access and inactive membership stay invisible; exact server-snapshot scoped
  clearing; no private shared-channel invalidation; correct deep links and
  preference/quiet-hour filtering.
- Worker tests: APNs/FCM/Web Push fan-out, exact-surface suppression, retry,
  dead-token handling, privacy-preserving private alert dispatch, and
  revoked-access suppression for both new categories; interactive agent-reply
  routing, generic protected-reply delivery, and run-level notification dedupe.
- Admin tests: counters, scoped clear mutations, and project-tab badges.
- Native tests/export: bridge message validation, server-total iOS badge
  updates, OS-notification dismissal, and iPhone/iPad/Android tab badges.
- Visual verification: Playwright at `/settings/notifications` and a project
  Board/Docs view.
- Operator verification: the supplied Apple `.p8` was uploaded through the
  super-admin Push Credentials surface as an APNs **production** credential for
  `com.km.nessie`, and its test action was accepted by Apple against a
  registered iPhone/iPad token. Android end-to-end verification still requires
  the Firebase Android client configuration and FCM service-account credential.
