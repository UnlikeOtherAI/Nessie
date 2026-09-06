-- The public webhook intake (`POST /api/triggers/webhook`) authenticates a
-- caller by its bearer key. It used to do that by loading every webhook
-- trigger in the deployment — no tenant filter — and comparing the presented
-- key against each one in the API process, so an unauthenticated caller could
-- drive an unbounded cross-tenant scan on demand (2026-09-05 API architecture
-- review, FO3-7). The route now looks the key up instead; this is the index
-- that lookup rides.
--
-- The key lives inside the `config` JSON document (written by
-- packages/team-admin/src/trigger-core.ts `ensureWebhookConfig`), so the index
-- is on the extracted text rather than on a column: adding a column would mean
-- every writer of that document had to remember to maintain it. The predicate
-- mirrors the route's own WHERE exactly — a trigger that carries a
-- `signing_secret` must use the HMAC-signed endpoint and is never matched by
-- bearer key.
CREATE INDEX IF NOT EXISTS "agent_triggers_webhook_api_key_idx"
  ON "agent_triggers" (("config" ->> 'apiKey'))
  WHERE "type" = 'webhook'::"AgentTriggerType" AND "signing_secret" IS NULL;
