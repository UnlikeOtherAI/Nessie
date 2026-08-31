-- A template-backed to-do pins the exact template version it copied, while a
-- standalone to-do has neither provenance field. Keep partial provenance
-- unrepresentable even for writers outside the service layer.
ALTER TABLE "agent_todos"
  ADD CONSTRAINT "agent_todos_template_version_pin_chk"
  CHECK (
    ("template_id" IS NULL AND "template_version" IS NULL)
    OR ("template_id" IS NOT NULL AND "template_version" IS NOT NULL)
  );
