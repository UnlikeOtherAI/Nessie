-- A temporary no-context browser has no durable AgentBrowser row to own a
-- viewport. Store its selected size on the session instead, retaining NULL as
-- the laptop default for every pre-existing row.
ALTER TABLE "cloud_browser_sessions"
  ADD COLUMN "viewport_width" INTEGER,
  ADD COLUMN "viewport_height" INTEGER;

-- A partial viewport makes remote pointer mapping unsafe. The accepted bounds
-- match BrowserViewportSchema and the durable-browser viewport constraint.
ALTER TABLE "cloud_browser_sessions"
  ADD CONSTRAINT "cloud_browser_sessions_viewport_chk" CHECK (
    ("viewport_width" IS NULL) = ("viewport_height" IS NULL)
    AND ("viewport_width" IS NULL OR (
      "viewport_width" BETWEEN 320 AND 3840
      AND "viewport_height" BETWEEN 320 AND 2160
    ))
  );
