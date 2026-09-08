CREATE TABLE "message_disclosure_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "message_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "source_channel_id" UUID NOT NULL,
    "source_author_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "message_disclosure_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_disclosure_sources_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_disclosure_sources_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_disclosure_sources_source_channel_id_fkey"
    FOREIGN KEY ("source_channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "message_disclosure_sources_source_author_user_id_fkey"
      FOREIGN KEY ("source_author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "message_disclosure_sources_message_channel_author_key"
  ON "message_disclosure_sources"("message_id", "source_channel_id", "source_author_user_id");

CREATE INDEX "message_disclosure_sources_org_idx"
  ON "message_disclosure_sources"("organization_id");
