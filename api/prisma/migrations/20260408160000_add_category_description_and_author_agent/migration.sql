-- AlterTable
ALTER TABLE "agent_categories" ADD COLUMN "description" TEXT;
ALTER TABLE "agent_categories" ADD COLUMN "author_agent_id" UUID;

-- AddForeignKey
ALTER TABLE "agent_categories" ADD CONSTRAINT "agent_categories_author_agent_id_fkey" FOREIGN KEY ("author_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
