CREATE TABLE "run_checkpoint_disclosure_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "checkpoint_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "source_channel_id" UUID NOT NULL,
  "source_author_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_checkpoint_disclosure_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_checkpoint_disclosure_sources_checkpoint_id_fkey"
    FOREIGN KEY ("checkpoint_id") REFERENCES "run_checkpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_checkpoint_disclosure_sources_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_checkpoint_disclosure_sources_source_channel_id_fkey"
    FOREIGN KEY ("source_channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_checkpoint_disclosure_sources_source_author_user_id_fkey"
    FOREIGN KEY ("source_author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "run_checkpoint_disclosure_sources_checkpoint_channel_author_key"
  ON "run_checkpoint_disclosure_sources"("checkpoint_id", "source_channel_id", "source_author_user_id");
CREATE INDEX "run_checkpoint_disclosure_sources_org_idx"
  ON "run_checkpoint_disclosure_sources"("organization_id");

CREATE TABLE "thought_disclosure_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "thought_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "source_channel_id" UUID NOT NULL,
  "source_author_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "thought_disclosure_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "thought_disclosure_sources_thought_id_fkey"
    FOREIGN KEY ("thought_id") REFERENCES "thoughts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "thought_disclosure_sources_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "thought_disclosure_sources_source_channel_id_fkey"
    FOREIGN KEY ("source_channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "thought_disclosure_sources_source_author_user_id_fkey"
    FOREIGN KEY ("source_author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "thought_disclosure_sources_thought_channel_author_key"
  ON "thought_disclosure_sources"("thought_id", "source_channel_id", "source_author_user_id");
CREATE INDEX "thought_disclosure_sources_org_idx"
  ON "thought_disclosure_sources"("organization_id");
