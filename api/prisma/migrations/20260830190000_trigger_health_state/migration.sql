-- Trigger health: make a non-runnable schedule say why, and make it recoverable.
--
-- A scheduled trigger whose saved UOA identity no longer verified was flipped to
-- `error` and abandoned: the scheduler only claims `status = 'active'`, the
-- delivery-retry poller clears `next_retry_at` for a non-active trigger, and
-- nothing notified anyone. The only record of the cause was the newest delivery
-- row's `error_message`, which a person had to go and read. One production
-- schedule stayed dead and silent for 19 days that way.
--
-- Three additions, all additive and backfill-free:
--
--   * `needs_reauthorization` splits "an authorized person must re-authorize
--     this" from `error`'s "fix the configuration". They need different buttons,
--     so they cannot be one state. Both remain non-runnable.
--   * `health_reason` / `health_detail` persist the cause as a stable code plus
--     the sentence shown to a person.
--   * `health_revision` identifies a transition, so the alert can fire exactly
--     once per failure via the `user_alerts.event_key` uniqueness that already
--     exists — no second dedupe table.
--
-- Existing rows keep `status`, get NULL reasons and revision 0. Nothing is
-- reclassified: a trigger already sitting in `error` stays there, because this
-- migration cannot know whether its cause was identity drift or a bad target.
-- The next fire classifies it correctly.

ALTER TYPE "AgentTriggerStatus" ADD VALUE IF NOT EXISTS 'needs_reauthorization';

ALTER TABLE "agent_triggers" ADD COLUMN "health_reason" TEXT;
ALTER TABLE "agent_triggers" ADD COLUMN "health_detail" TEXT;
ALTER TABLE "agent_triggers" ADD COLUMN "health_revision" INTEGER NOT NULL DEFAULT 0;

-- The bell surfaces this alongside mentions, so the failure reaches a person
-- where they already look rather than only on the Triggers page.
ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'trigger_health';

ALTER TABLE "user_alerts" ADD COLUMN "trigger_id" UUID;

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_trigger_id_fkey"
  FOREIGN KEY ("trigger_id") REFERENCES "agent_triggers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The notification's real destination. Without its own value it would have to
-- borrow another surface's identity, and presence suppression would then drop
-- the alert for anyone sitting on that unrelated page.
ALTER TYPE "PushSurfaceKind" ADD VALUE IF NOT EXISTS 'triggers';
