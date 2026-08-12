-- W17 (§5): the designer's persisted per-step samples from the last
-- successful test run. A new sensitive-data store: values are W0-redacted at
-- write time, provenance is carried in the payload, and the template cascade
-- deletes it with its owner.
ALTER TABLE "workflow_templates"
  ADD COLUMN "step_samples" JSONB NOT NULL DEFAULT '{}'::jsonb;
