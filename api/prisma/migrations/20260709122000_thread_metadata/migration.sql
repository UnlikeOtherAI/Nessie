-- External-agent groundwork (§5/§6): threads carry a free-form JSON metadata bag
-- so an external-conversation surface can persist the product-side conversation
-- id (e.g. `metadata->'deepsignal'->>'conversationId'`) that keys every turn to
-- the external service's conversation. Additive only — existing threads default
-- to an empty object.

ALTER TABLE "threads"
  ADD COLUMN "metadata" JSONB DEFAULT '{}';
