-- DeepWater research briefs: the three result facts the research view shows
-- that no earlier column holds.
--
--   launched_at       when the agreed brief was launched (the view's
--                     `startedAt`; `requested_at` is when the brief was opened).
--   report_truncated  Ledger's `truncated` flag for the delivered report, shown
--                     on the card, the Knowledge page and Copy markdown.
--   public_url        the finished report's link on research.deepwater.live,
--                     present only for a person's public launch. Ledger passes
--                     it through only from that exact origin, and so does this
--                     column.
--
-- Additive with defaults or NULL, so the previous build keeps writing rows.
ALTER TABLE "product_integration_runs"
  ADD COLUMN "launched_at" TIMESTAMP(3),
  ADD COLUMN "report_truncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "public_url" TEXT;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_public_url_check"
    CHECK ("public_url" IS NULL OR "public_url" LIKE 'https://research.deepwater.live/%');
