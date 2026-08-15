ALTER TABLE "organizations" ADD COLUMN "external_org_id" TEXT;

CREATE UNIQUE INDEX "organizations_external_org_id_key" ON "organizations"("external_org_id");
