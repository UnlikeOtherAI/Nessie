-- Session-to-binding relations already prove the exact run boundary. The
-- unused digest duplicated that relation without a consumer.
ALTER TABLE "executor_sessions" DROP COLUMN "workspace_grant_digest";
