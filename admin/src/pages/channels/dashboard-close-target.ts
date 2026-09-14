/**
 * Where closing the dashboard workspace panel goes.
 *
 * The panel is a sibling of the reply-thread panel and closes the same way that
 * one does — back to the conversation it was presented in. It used to navigate
 * to `/channels/:channelId/threads/:threadId` when the panel had been opened
 * from a thread, which then read like a route and was not one: the router
 * declared `…/threads/:threadId/replies/:rootMessageId` and
 * `…/threads/:threadId/dashboards/:dashboardId`, but nothing at the bare
 * thread. So Close fell through to the `*` catch-all and rendered
 * NotFoundPage — the one action on the panel that must always work.
 *
 * That bare thread route now exists (agent conversations,
 * docs/plans/2026-09-08-agent-conversations.md), and this is the deliberate
 * decision `admin/test/dashboard-close-target.test.ts` demanded when it did:
 * a dashboard presented *inside a conversation* closes back into that
 * conversation, because closing a panel must never also leave the thread the
 * reader was in. A dashboard in a room's General thread closes to the room, as
 * before — the caller passes no thread there, so nothing about that path
 * changes.
 *
 * A function rather than an inline template so both destinations can be
 * asserted against the real route table: `dashboardCloseTarget(':channelId')`
 * and `dashboardCloseTarget(':channelId', ':threadId')` render the route
 * patterns themselves, and the test checks each is one `router.tsx` declares.
 */
export const dashboardCloseTarget = (
  channelId: string,
  conversationThreadId?: string | null,
): string =>
  conversationThreadId
    ? `/channels/${channelId}/threads/${conversationThreadId}`
    : `/channels/${channelId}`
