-- AlterTable: "public read-only, private write" support
ALTER TABLE "knowledge_spaces" ADD COLUMN "write_restricted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: explicit per-space access grants
CREATE TABLE "knowledge_space_members" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_space_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_space_members_user_id_idx" ON "knowledge_space_members"("user_id");

-- CreateIndex
CREATE INDEX "knowledge_space_members_organization_id_idx" ON "knowledge_space_members"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_space_members_space_id_user_id_key" ON "knowledge_space_members"("space_id", "user_id");

-- AddForeignKey
ALTER TABLE "knowledge_space_members" ADD CONSTRAINT "knowledge_space_members_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "knowledge_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_space_members" ADD CONSTRAINT "knowledge_space_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
