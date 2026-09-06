-- Agent browser tabs: what an agent's browser was last on, kept after the
-- session that opened it is gone, so the chat's Browser column has a real
-- last state to show and a resume has somewhere to go back to.
--
-- `agent_browser_tabs` is rewritten as a set on every capture — after a
-- navigation and just before release — so it is always the latest state,
-- never a history. The screenshot is stored in the row: it is the product's
-- own snapshot for its own screen, bounded by the tab count and overwritten a
-- few times a session, not a person's file that needs a quota, a thumbnail
-- and a message to hang off. It is kept small at capture (a JPEG scaled to a
-- thumbnail column; see packages/browser-cloud/src/agent-browser-tabs.ts).
--
-- `cloud_browser_sessions.run_id` becomes nullable: a person can now resume
-- the agent's browser from the conversation, and that session has no run.
-- It has no terminal transition to free it either, so it lives on a short
-- idle TTL that each read of its live view extends, capped at the ordinary
-- session TTL, and the existing reaper stops it like any other. The partial
-- unique index on a live run's session is unaffected (NULLs are distinct);
-- the one-live-session-per-durable-browser index still applies, which is what
-- makes "the agent's browser is open in another run" true for a resume too.

-- AlterTable
ALTER TABLE "cloud_browser_sessions" ALTER COLUMN "run_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "agent_browser_tabs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_browser_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "screenshot" BYTEA,
    "screenshot_mime" TEXT,
    "captured_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_browser_tabs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_browser_tabs_agent_browser_id_position_key" ON "agent_browser_tabs"("agent_browser_id", "position");

-- AddForeignKey
ALTER TABLE "agent_browser_tabs" ADD CONSTRAINT "agent_browser_tabs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_browser_tabs" ADD CONSTRAINT "agent_browser_tabs_agent_browser_id_fkey" FOREIGN KEY ("agent_browser_id") REFERENCES "agent_browsers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
