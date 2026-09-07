-- A failed Browserbase stop is uncertain, not released. Keep its durable
-- context exclusively claimed until the reaper confirms the remote session is
-- gone, so reset/reopen cannot race a still-running provider session.
DROP INDEX "cloud_browser_sessions_live_run_key";
DROP INDEX "cloud_browser_sessions_live_agent_browser_key";

CREATE UNIQUE INDEX "cloud_browser_sessions_live_run_key"
  ON "cloud_browser_sessions"("run_id")
  WHERE "status" IN (
      'allocating'::"CloudBrowserSessionStatus",
      'active'::"CloudBrowserSessionStatus",
      'releasing'::"CloudBrowserSessionStatus",
      'unknown'::"CloudBrowserSessionStatus"
    );

CREATE UNIQUE INDEX "cloud_browser_sessions_live_agent_browser_key"
  ON "cloud_browser_sessions"("agent_browser_id")
  WHERE "agent_browser_id" IS NOT NULL
    AND "status" IN (
      'allocating'::"CloudBrowserSessionStatus",
      'active'::"CloudBrowserSessionStatus",
      'releasing'::"CloudBrowserSessionStatus",
      'unknown'::"CloudBrowserSessionStatus"
    );
