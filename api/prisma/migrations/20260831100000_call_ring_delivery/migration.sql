ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'call_missed';

ALTER TABLE "user_alerts"
  ADD COLUMN "call_id" UUID;

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "user_alerts_call_id_idx" ON "user_alerts"("call_id");
