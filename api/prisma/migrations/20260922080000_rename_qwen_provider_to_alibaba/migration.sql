-- Ledger renamed its Alibaba Cloud Model Studio service from `qwen` to
-- `alibaba`, and the provider key an agent stores IS that Ledger service id:
-- it becomes the `/v1/:serviceId` segment every inference call for the agent
-- addresses. Rows still naming `qwen` would address a service Ledger no
-- longer has and fail with "token not allowed for qwen" until edited by hand.
--
-- Live selectors only. `token_ledger_events.provider` is history and keeps
-- the name the spend was recorded under.
UPDATE "agents"
   SET "provider" = 'alibaba'
 WHERE "provider" = 'qwen';

UPDATE "inference_providers"
   SET "provider_key" = 'alibaba'
 WHERE "provider_key" = 'qwen';

UPDATE "budgets"
   SET "degrade_provider" = 'alibaba'
 WHERE "degrade_provider" = 'qwen';
