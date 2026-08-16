-- Retire the grandfathered `inference_credential_bindings.auth_secret_ref`
-- environment references.
--
-- WHY THIS IS A MIGRATION AND NOT A GUARD
-- The worker resolves a binding as `process.env[auth_secret_ref]` and sends the
-- result as a bearer token to the provider's own `base_url`. New writes have
-- been refused server-side since the phase-0 secret-custody gate
-- (`InferenceEnvRefForbiddenError`) and base URLs are SSRF-checked, but every
-- row written before that gate is still a live dereference of an arbitrary
-- host environment variable — DATABASE_URL, a signing key, LEDGER_PROXY_TOKEN —
-- chosen by an organisation owner and aimed at an endpoint they also chose.
-- That is instance-scoped state under tenant control, so it is retired here
-- rather than guarded again.
--
-- WHAT "RETIRED" MEANS
-- Exactly what the control plane's own `revokeInferenceCredentialBinding` does,
-- applied to every surviving row: the binding is revoked and detached from its
-- provider. `POST/PATCH` already refuses to re-attach a revoked binding
-- (`INFERENCE_CREDENTIAL_BINDING_NOT_FOUND`) and refuses to create a new env
-- ref, so a retired row can never be dereferenced again. `auth_secret_ref` is
-- an environment variable *name*, not a secret, and is left in place so an
-- operator can still read which deployment variable a provider used to point
-- at while they migrate it.
--
-- OPERATOR IMPACT (read before deploying)
-- * Compiled providers (`openai`, `deepseek`, `kimi`, `minimax`) keep working:
--   they fall back to the deployment-level credential
--   (`NESSIE_MODEL_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / ...).
--   Only the arbitrary env dereference is gone.
-- * `openai_compatible` providers have no such fallback, so any that were
--   running on a grandfathered binding are disabled here and marked
--   `unreachable`, restoring the service invariant that an OpenAI-compatible
--   provider must hold a credential binding before it is enabled
--   (`INFERENCE_PROVIDER_OPENAI_COMPATIBLE_REQUIRES_BINDING`). Their approval
--   is reset to `draft`, mirroring what a material provider change does. The
--   owner sees a disabled, unreachable, draft provider on the inference
--   control-plane screen rather than a run failing later with an opaque
--   "Missing API key for provider X".
-- * Restoring such a provider means configuring its credential at the
--   deployment level (env), not re-creating an env ref: the control plane will
--   refuse that write.

-- 1. Revoke every surviving grandfathered binding.
UPDATE "inference_credential_bindings"
SET "revoked_at" = now(),
    "updated_at" = now()
WHERE "revoked_at" IS NULL;

-- 2. Detach the retired bindings from their providers, so nothing joins to a
--    revoked row. This is the step that ends the dereference.
UPDATE "inference_providers"
SET "active_credential_binding_id" = NULL,
    "updated_at" = now()
WHERE "active_credential_binding_id" IS NOT NULL;

-- 3. An OpenAI-compatible provider with no binding cannot authenticate at all.
--    Fail it loudly and visibly instead of at the next inference call.
UPDATE "inference_providers"
SET "enabled" = false,
    "health_status" = 'unreachable',
    "lifecycle_status" = 'draft',
    "approved_by_actor_id" = NULL,
    "approved_at" = NULL,
    "updated_at" = now()
-- The database enum label is the hyphenated `openai-compatible`
-- (`InferenceConnectorKind.openai_compatible @map("openai-compatible")`).
WHERE "connector_kind" = 'openai-compatible'
  AND "active_credential_binding_id" IS NULL;
