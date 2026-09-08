-- Publishing stops being a pairing-time checkbox and becomes the approval it
-- already is everywhere else.
--
-- `documents_publish` decided, once and for ninety days, a question this
-- product asks per document — and decided it before the document existed. A
-- paired agent now opens the same `knowledge.page.publish` approval that
-- `kb_publish_request` opens for an in-house agent, pinned to the person whose
-- account it borrows.

-- 1. An approval can now come from a paired credential instead of an agent.
--    A credential has no `Agent` row to point at, so `agent_id` becomes
--    nullable and exactly one of the two identifies the requester.
ALTER TABLE "approval_requests"
  ALTER COLUMN "agent_id" DROP NOT NULL;

ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "agent_access_credential_id" UUID;

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_agent_access_credential_id_fkey"
  FOREIGN KEY ("agent_access_credential_id")
  REFERENCES "agent_access_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one asker. Without this a row could name both, or neither, and every
-- presenter would have to invent an answer for a state that has none.
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_one_asker"
  CHECK (("agent_id" IS NULL) <> ("agent_access_credential_id" IS NULL));

CREATE INDEX IF NOT EXISTS "approval_requests_agent_access_credential_id_status_idx"
  ON "approval_requests" ("agent_access_credential_id", "status");

-- 2. Retire the scope. Strip it from every array before the type is recreated;
--    a credential that held it keeps everything else it was granted, and loses
--    only the power that is now a per-document decision.
UPDATE "agent_access_credentials"
  SET "scopes" = array_remove("scopes", 'documents_publish')
  WHERE 'documents_publish' = ANY ("scopes");

UPDATE "agent_authorization_requests"
  SET "requested_scopes" = array_remove("requested_scopes", 'documents_publish')
  WHERE 'documents_publish' = ANY ("requested_scopes");

UPDATE "agent_authorization_requests"
  SET "approved_scopes" = array_remove("approved_scopes", 'documents_publish')
  WHERE 'documents_publish' = ANY ("approved_scopes");

-- Postgres cannot drop a value from an enum, so the type is recreated. The
-- defaults have to come off first: they are typed to the old enum and would
-- pin it alive.
ALTER TABLE "agent_access_credentials" ALTER COLUMN "scopes" DROP DEFAULT;
ALTER TABLE "agent_authorization_requests" ALTER COLUMN "requested_scopes" DROP DEFAULT;
ALTER TABLE "agent_authorization_requests" ALTER COLUMN "approved_scopes" DROP DEFAULT;

ALTER TYPE "AgentAccessScope" RENAME TO "AgentAccessScope_old";

CREATE TYPE "AgentAccessScope" AS ENUM (
  'boards_read',
  'boards_write',
  'documents_read',
  'documents_write'
);

ALTER TABLE "agent_access_credentials"
  ALTER COLUMN "scopes" TYPE "AgentAccessScope"[]
  USING "scopes"::text[]::"AgentAccessScope"[];

ALTER TABLE "agent_authorization_requests"
  ALTER COLUMN "requested_scopes" TYPE "AgentAccessScope"[]
  USING "requested_scopes"::text[]::"AgentAccessScope"[];

ALTER TABLE "agent_authorization_requests"
  ALTER COLUMN "approved_scopes" TYPE "AgentAccessScope"[]
  USING "approved_scopes"::text[]::"AgentAccessScope"[];

ALTER TABLE "agent_access_credentials"
  ALTER COLUMN "scopes" SET DEFAULT ARRAY[]::"AgentAccessScope"[];
ALTER TABLE "agent_authorization_requests"
  ALTER COLUMN "requested_scopes" SET DEFAULT ARRAY[]::"AgentAccessScope"[];
ALTER TABLE "agent_authorization_requests"
  ALTER COLUMN "approved_scopes" SET DEFAULT ARRAY[]::"AgentAccessScope"[];

DROP TYPE "AgentAccessScope_old";
