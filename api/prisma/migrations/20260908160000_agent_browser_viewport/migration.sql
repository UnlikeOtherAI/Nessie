-- A remembered window size per agent browser.
--
-- Browserbase fixes a session's viewport at creation, so this is read when a
-- session opens rather than applied to a running one; a live resize goes
-- through CDP and writes here so the next session comes back the same size.
-- NULL is "the default laptop window", which keeps every existing row on the
-- default without a backfill.
ALTER TABLE "agent_browsers"
  ADD COLUMN "viewport_width" INTEGER,
  ADD COLUMN "viewport_height" INTEGER;

-- Half a viewport is not a viewport: a row either overrides the default or it
-- does not. The bounds are the provider's own working range — below 320 the
-- live view is unusable and above 3840 sessions are refused.
ALTER TABLE "agent_browsers"
  ADD CONSTRAINT "agent_browsers_viewport_chk" CHECK (
    ("viewport_width" IS NULL) = ("viewport_height" IS NULL)
    AND ("viewport_width" IS NULL OR (
      "viewport_width" BETWEEN 320 AND 3840
      AND "viewport_height" BETWEEN 320 AND 2160
    ))
  );
