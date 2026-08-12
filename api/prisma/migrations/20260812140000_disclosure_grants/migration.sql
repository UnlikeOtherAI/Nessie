-- Disclosure grants: the two ways a restriction is lifted.
--
-- `disclosure_grants` is the acknowledgement card's "share this reply" — one
-- message, one audience, permanent until revoked.
--
-- `scope_disclosure_grants` is "allow always": a standing permission for one
-- source scope into one destination channel for one agent, with a duration
-- chosen by the granter. Non-widening is structural — evaluation is a single
-- exact-key lookup with no wildcard, inheritance, or fallback path, so a grant
-- for P into C implies nothing about Q into C or P into D.
--
-- Both evaluate at read time against the granter's CURRENT membership, so a
-- grant goes inert the moment its granter loses access to the source and
-- revocation needs no propagation.

CREATE TABLE "disclosure_grants" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID NOT NULL,
  "message_id"       UUID NOT NULL,
  "granted_by_user_id" UUID NOT NULL,
  "audience_kind"    TEXT NOT NULL,          -- 'user' | 'channel'
  "audience_id"      UUID NOT NULL,
  "expires_at"       TIMESTAMP(3),
  "revoked_at"       TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now(),

  CONSTRAINT "disclosure_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "disclosure_grants_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "disclosure_grants_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "disclosure_grants_granted_by_user_id_fkey"
    FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "disclosure_grants_message_audience_key"
  ON "disclosure_grants"("message_id", "audience_kind", "audience_id");
CREATE INDEX "disclosure_grants_org_idx" ON "disclosure_grants"("organization_id");

CREATE TABLE "scope_disclosure_grants" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID NOT NULL,
  "source_scope_type" TEXT NOT NULL,
  "source_scope_id"  UUID NOT NULL,
  "destination_channel_id" UUID NOT NULL,
  "agent_id"         UUID NOT NULL,
  "granted_by_user_id" UUID NOT NULL,
  "expires_at"       TIMESTAMP(3),
  "revoked_at"       TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now(),

  CONSTRAINT "scope_disclosure_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scope_disclosure_grants_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "scope_disclosure_grants_destination_channel_id_fkey"
    FOREIGN KEY ("destination_channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "scope_disclosure_grants_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "scope_disclosure_grants_granted_by_user_id_fkey"
    FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "scope_disclosure_grants_key"
  ON "scope_disclosure_grants"("source_scope_type", "source_scope_id", "destination_channel_id", "agent_id");
CREATE INDEX "scope_disclosure_grants_org_idx"
  ON "scope_disclosure_grants"("organization_id");
CREATE INDEX "scope_disclosure_grants_destination_idx"
  ON "scope_disclosure_grants"("destination_channel_id");
