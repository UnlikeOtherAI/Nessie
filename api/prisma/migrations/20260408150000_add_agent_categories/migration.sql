-- CreateEnum
CREATE TYPE "AgentCategoryVisibility" AS ENUM ('public', 'private');

-- CreateTable
CREATE TABLE "agent_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "visibility" "AgentCategoryVisibility" NOT NULL DEFAULT 'public',
    "organization_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_category_agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_category_agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_categories_organization_id_visibility_idx" ON "agent_categories"("organization_id", "visibility");

-- CreateIndex
CREATE INDEX "agent_category_agents_agent_id_idx" ON "agent_category_agents"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_category_agents_category_id_agent_id_key" ON "agent_category_agents"("category_id", "agent_id");

-- AddForeignKey
ALTER TABLE "agent_categories" ADD CONSTRAINT "agent_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_categories" ADD CONSTRAINT "agent_categories_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_category_agents" ADD CONSTRAINT "agent_category_agents_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "agent_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_category_agents" ADD CONSTRAINT "agent_category_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
