/**
 * Where closing the dashboard workspace panel goes.
 *
 * The panel is a sibling of the reply-thread panel and closes the same way that
 * one does — back to the channel (`useReplyThread`'s `closeThread`). It used to
 * navigate to `/channels/:channelId/threads/:threadId` when the panel had been
 * opened from a thread, which reads like a route and is not one: the router
 * declares `…/threads/:threadId/replies/:rootMessageId` and
 * `…/threads/:threadId/dashboards/:dashboardId`, but nothing at the bare thread.
 * So Close fell through to the `*` catch-all and rendered NotFoundPage — the
 * one action on the panel that must always work.
 *
 * A function rather than an inline template so the destination can be asserted
 * against the real route table: `dashboardCloseTarget(':channelId')` renders the
 * route pattern itself, and `admin/test/dashboard-close-target.test.ts` checks
 * that pattern is one `router.tsx` actually declares.
 */
export const dashboardCloseTarget = (channelId: string): string =>
  `/channels/${channelId}`
