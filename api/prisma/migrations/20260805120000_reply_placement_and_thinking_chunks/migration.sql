-- Model-judged reply placement + the durable agent thought log.
--
-- `runs.reply_placement` records the pre-run placement judgement made by the
-- engagement orchestrator (or stamped structurally for @mentions and PA DMs);
-- NULL means the historical default (reply into the trigger's reply thread).
-- `runs.reply_root_message_id` records the RESOLVED anchor the worker computed
-- once the structural carve-outs (DeepWater handoff, external agents) were
-- applied, so readers never re-derive placement.
--
-- `run_thinking_chunks` is the retrievable thought process behind the live
-- "thinking" bubble: the SSE stream is deliberately live-only (never replayed
-- from backlog), so each coalesced reasoning flush and each tool line is also
-- persisted here and published with its id, letting clients merge fetched
-- history with live events without duplication.

CREATE TYPE "RunReplyPlacement" AS ENUM ('thread', 'channel');

CREATE TYPE "RunThinkingChunkKind" AS ENUM ('reasoning', 'tool');

ALTER TABLE "runs"
  ADD COLUMN "reply_placement" "RunReplyPlacement",
  ADD COLUMN "reply_root_message_id" UUID;

CREATE TABLE "run_thinking_chunks" (
  "id" BIGSERIAL NOT NULL,
  "run_id" UUID NOT NULL,
  "kind" "RunThinkingChunkKind" NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_thinking_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_thinking_chunks_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "run_thinking_chunks_run_id_id_idx"
  ON "run_thinking_chunks"("run_id", "id");
