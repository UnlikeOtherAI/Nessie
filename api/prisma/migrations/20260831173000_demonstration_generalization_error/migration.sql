-- A failed or disclosure-blocked generalization remains reviewable, with an
-- actionable reason on the same demonstration rather than a silent retry loop.
ALTER TABLE "demonstrations"
  ADD COLUMN "generalization_error" TEXT;
