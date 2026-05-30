-- Remove dead inference subsystems: eval suites/runs, tool mediator profiles,
-- and capability overrides. These subsystems never executed (no eval runner
-- existed, and the worker never read mediator/override config), so dropping
-- them changes no runtime behaviour.
--
-- Note: the organization_id foreign keys on the surviving inference tables
-- (providers, models, credential bindings, routing profiles) are restored by
-- migration 20260530170100_reinstate_inference_org_fkeys, so they are not
-- touched here.

-- CASCADE also removes the inference_routing_profiles -> tool_mediator_profiles
-- foreign key and the eval tables' relations. The tool_mediator_profile_id
-- column on inference_routing_profiles is intentionally kept (now a plain
-- nullable uuid with no foreign key).
DROP TABLE IF EXISTS "inference_eval_runs" CASCADE;
DROP TABLE IF EXISTS "inference_eval_suites" CASCADE;
DROP TABLE IF EXISTS "inference_capability_overrides" CASCADE;
DROP TABLE IF EXISTS "tool_mediator_profiles" CASCADE;

-- Drop the now-unused enum type backing inference_eval_runs.status.
DROP TYPE IF EXISTS "InferenceEvalStatus";
