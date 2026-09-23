/**
 * The action purpose of an agent mailbox delivery that carries neither a
 * peer-delegation requester nor a task set (`buildMailboxActorContext`):
 * workflow and plan step mail, and anything else sent through
 * `POST /api/mailbox`. Every delivery is a hidden `system` kickoff whose body
 * is its whole prompt, so a delivery that pends behind a busy agent drains
 * alone (`packages/db/src/thread-serialization.ts`) instead of being dropped
 * from a batch that only its latest row drives.
 */
export const MAILBOX_DELIVERY_PURPOSE = 'mailbox.delivery'
