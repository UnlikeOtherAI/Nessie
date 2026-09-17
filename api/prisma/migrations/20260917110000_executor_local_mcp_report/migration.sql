-- What each executor's daemon last observed about the local MCP servers its
-- reviewed policy names, and for Kelpie the browsers it found on that network.
--
-- Nullable on purpose. NULL means "this executor has never reported", which is
-- a different fact from a stored empty array, which means "it reports, and it
-- names no server". A NOT NULL DEFAULT '[]' would collapse the two and make
-- every pre-existing executor claim to have answered.
ALTER TABLE "executors" ADD COLUMN "local_mcp" JSONB;

-- When the daemon took that observation. It is stored beside the report rather
-- than read out of it so a reader can order and age-filter without parsing
-- JSON, and so "we heard nothing" stays distinguishable from "we heard, and it
-- was empty".
ALTER TABLE "executors" ADD COLUMN "local_mcp_observed_at" TIMESTAMP(3);
