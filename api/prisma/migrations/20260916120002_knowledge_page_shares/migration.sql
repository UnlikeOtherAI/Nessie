-- Person-to-person sharing of a page in the sharer's own personal space.
--
-- No backfill: nothing has ever been shared this way, and the table is born
-- with both access levels, so no row ever needs re-levelling.
CREATE TYPE "KnowledgePageShareAccess" AS ENUM ('view', 'edit');

CREATE TABLE "knowledge_page_shares" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "grantee_user_id" UUID NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "access" "KnowledgePageShareAccess" NOT NULL DEFAULT 'view',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_page_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_page_shares_page_id_grantee_user_id_key"
    ON "knowledge_page_shares"("page_id", "grantee_user_id");

CREATE INDEX "knowledge_page_shares_grantee_created_idx"
    ON "knowledge_page_shares"("grantee_user_id", "created_at" DESC);

CREATE INDEX "knowledge_page_shares_org_space_idx"
    ON "knowledge_page_shares"("organization_id", "space_id");

ALTER TABLE "knowledge_page_shares"
    ADD CONSTRAINT "knowledge_page_shares_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_page_shares"
    ADD CONSTRAINT "knowledge_page_shares_page_id_fkey"
    FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_page_shares"
    ADD CONSTRAINT "knowledge_page_shares_grantee_user_id_fkey"
    FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
