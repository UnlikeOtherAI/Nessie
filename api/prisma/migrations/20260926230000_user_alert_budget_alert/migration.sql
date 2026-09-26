-- Budget alerts reach the bell (docs/plans/2026-09-26-admin-ux-overhaul.md
-- §10.9). A budget that crosses its warn threshold, or first stops work, was a
-- push alone: an owner with no registered device never heard. The dispatch now
-- writes one `budget_alert` row per active owner, pointing at the
-- `budget_alerts` marker that already makes the alert once per budget, period
-- and kind, and deleting the marker deletes the rows.
--
-- Like `trigger_machine_access`, this value is written in the same deploy that
-- adds it, and that is safe: nothing publishes it — no realtime `alert.created`
-- frame — and a replica of the previous build selects bell rows only through
-- its own `visibleUserAlertWhere`, which has no arm for this kind, so it never
-- reads one. The value must exist before the new build writes it, and
-- `prisma migrate deploy` runs before the swap.
ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'budget_alert';

ALTER TABLE "user_alerts" ADD COLUMN "budget_alert_id" UUID;

CREATE INDEX "user_alerts_budget_alert_id_idx" ON "user_alerts"("budget_alert_id");

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_budget_alert_id_fkey"
  FOREIGN KEY ("budget_alert_id") REFERENCES "budget_alerts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
