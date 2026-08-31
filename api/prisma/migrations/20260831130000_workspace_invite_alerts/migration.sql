ALTER TYPE "UserAlertKind" ADD VALUE 'workspace_invitation';

ALTER TABLE "user_alerts"
  ADD COLUMN "metadata" JSONB;
