-- Ticket work: the hours clock, the open question and an undeliverable
-- reminder (T3, docs/standards/ticket-work.md → "Reminders, the quiet wake
-- and the sweep (T3)").
--
--   clock_started_at       when the hours clock last started running. NULL
--                          while it is paused: the record is not `active`, or
--                          a question the agent asked waits for a person. On
--                          every transition the elapsed time is folded into
--                          `active_ms` and the clock restarted or paused
--                          (`syncTicketWorkClock`).
--   awaiting_answer_at     when the agent's latest comment on the ticket asked
--                          the people on it something (`ticket_comment_add`
--                          with `awaitsAnswer: true`). The next person event
--                          that wakes the record clears it, and so does a later
--                          agent comment that asks nothing. While it is set,
--                          quiet wakes stop and the clock is paused.
--
-- Additive and NULL, so the previous build keeps writing rows.
ALTER TABLE "agent_ticket_work"
  ADD COLUMN "clock_started_at" TIMESTAMP(3),
  ADD COLUMN "awaiting_answer_at" TIMESTAMP(3);

-- Work already running when this lands starts its clock now: nothing measured
-- it before. Prisma stores UTC wall time in TIMESTAMP(3), whatever the
-- session's time zone.
UPDATE "agent_ticket_work"
  SET "clock_started_at" = (now() AT TIME ZONE 'UTC')
  WHERE "status" = 'active';

-- A reminder that came due where its agent can no longer wake — the thread or
-- its channel is gone, archived or a system conversation now, or the agent is
-- no longer in it — is cancelled `undeliverable` rather than recorded as fired.
-- The CHECK is dropped and re-added whole, as the vocabulary rule says
-- (`AgentReminderCancelledReasonSchema`, packages/schemas/src/ticket-work.ts).
ALTER TABLE "agent_reminders" DROP CONSTRAINT "agent_reminders_status_known";
ALTER TABLE "agent_reminders" ADD CONSTRAINT "agent_reminders_status_known"
  CHECK (
    (
      "status" = 'pending'
      AND "fired_at" IS NULL
      AND "cancelled_reason" IS NULL
    )
    OR (
      "status" = 'fired'
      AND "fired_at" IS NOT NULL
      AND "cancelled_reason" IS NULL
    )
    OR (
      "status" = 'cancelled'
      AND "fired_at" IS NULL
      AND "cancelled_reason" IS NOT NULL
      AND "cancelled_reason" IN ('replaced', 'work_ended', 'person', 'undeliverable')
    )
  );
