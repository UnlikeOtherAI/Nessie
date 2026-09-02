-- A browser sign-in handoff carries which browser and service the press
-- authorizes. Written by `browser_login_request` at post time and consumed by
-- the press, which records the login and releases the human-only session — so
-- somebody who signs in and presses Done is recorded even if the run they
-- unblocked then fails.
ALTER TABLE "agent_cards" ADD COLUMN "browser_login" JSONB;
