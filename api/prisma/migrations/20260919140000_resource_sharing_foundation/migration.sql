-- Cross-organisation sharing stores product authorization edges only. UOA
-- remains authoritative for organisations, teams, membership, and commercial
-- eligibility; no identity or subscription data is copied into these tables.

CREATE TYPE "ResourceShareScope" AS ENUM ('project', 'board');
CREATE TYPE "ResourceShareAccess" AS ENUM ('read', 'write');
CREATE TYPE "ResourceShareStatus" AS ENUM ('pending', 'active', 'declined', 'revoked', 'expired');
CREATE TYPE "ResourceShareHealth" AS ENUM ('healthy', 'suspended');

-- Composite FK targets make the tenant and ownership ancestry database facts.
CREATE UNIQUE INDEX "organizations_id_external_org_id_key"
  ON "organizations"("id", "external_org_id");
CREATE UNIQUE INDEX "teams_id_external_org_id_external_team_id_key"
  ON "teams"("id", "external_org_id", "external_team_id");
CREATE UNIQUE INDEX "projects_id_organization_id_team_id_key"
  ON "projects"("id", "organization_id", "team_id");
CREATE UNIQUE INDEX "boards_id_project_id_organization_id_key"
  ON "boards"("id", "project_id", "organization_id");
CREATE UNIQUE INDEX "task_field_definitions_id_project_id_organization_id_key"
  ON "task_field_definitions"("id", "project_id", "organization_id");
CREATE UNIQUE INDEX "iterations_id_project_id_organization_id_key"
  ON "iterations"("id", "project_id", "organization_id");
CREATE UNIQUE INDEX "knowledge_pages_id_project_id_organization_id_key"
  ON "knowledge_pages"("id", "project_id", "organization_id");

CREATE TABLE "resource_shares" (
  "id" UUID NOT NULL,
  "scope" "ResourceShareScope" NOT NULL,
  "source_organization_id" UUID NOT NULL,
  "source_external_org_id" TEXT NOT NULL,
  "source_team_id" UUID NOT NULL,
  "source_external_team_id" TEXT NOT NULL,
  "project_id" UUID NOT NULL,
  "target_board_id" UUID,
  "board_id" UUID,
  "recipient_organization_id" UUID NOT NULL,
  "recipient_external_org_id" TEXT NOT NULL,
  "recipient_team_id" UUID NOT NULL,
  "recipient_external_team_id" TEXT NOT NULL,
  "proposed_access" "ResourceShareAccess" NOT NULL,
  "proposed_revision" INTEGER NOT NULL DEFAULT 1,
  "effective_access" "ResourceShareAccess",
  "effective_revision" INTEGER,
  "status" "ResourceShareStatus" NOT NULL DEFAULT 'pending',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "expires_at" TIMESTAMPTZ(3),
  "created_by_subject" TEXT NOT NULL,
  "created_by_acting_org_ref" TEXT NOT NULL,
  "accepted_by_subject" TEXT,
  "accepted_by_acting_org_ref" TEXT,
  "accepted_at" TIMESTAMPTZ(3),
  "declined_by_subject" TEXT,
  "declined_by_acting_org_ref" TEXT,
  "declined_at" TIMESTAMPTZ(3),
  "revoked_by_subject" TEXT,
  "revoked_by_acting_org_ref" TEXT,
  "revoked_at" TIMESTAMPTZ(3),
  "expired_at" TIMESTAMPTZ(3),
  "health" "ResourceShareHealth" NOT NULL DEFAULT 'healthy',
  "health_reason_code" TEXT,
  "health_revision" INTEGER NOT NULL DEFAULT 1,
  "health_transitioned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "resource_shares_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_shares_distinct_organizations_chk" CHECK (
    "source_organization_id" <> "recipient_organization_id"
    AND "source_external_org_id" <> "recipient_external_org_id"
  ),
  CONSTRAINT "resource_shares_scope_board_chk" CHECK (
    ("scope" = 'project' AND "target_board_id" IS NULL AND "board_id" IS NULL)
    OR (
      "scope" = 'board'
      AND "target_board_id" IS NOT NULL
      AND (
        ("status" IN ('pending', 'active')
          AND "board_id" IS NOT NULL
          AND "board_id" = "target_board_id")
        OR ("status" IN ('declined', 'revoked', 'expired')
          AND ("board_id" IS NULL OR "board_id" = "target_board_id"))
      )
    )
  ),
  CONSTRAINT "resource_shares_revision_chk" CHECK (
    "revision" >= 1
    AND "proposed_revision" >= 1
    AND "proposed_revision" <= "revision"
    AND "health_revision" >= 1
    AND ("effective_revision" IS NULL OR (
      "effective_revision" >= 1
      AND "effective_revision" <= "proposed_revision"
    ))
  ),
  CONSTRAINT "resource_shares_effective_pair_chk" CHECK (
    ("effective_access" IS NULL) = ("effective_revision" IS NULL)
  ),
  CONSTRAINT "resource_shares_access_transition_chk" CHECK (
    "effective_access" IS NULL
    OR "effective_access" = "proposed_access"
    OR (
      "effective_access" = 'read'
      AND "proposed_access" = 'write'
      AND "effective_revision" < "proposed_revision"
    )
  ),
  CONSTRAINT "resource_shares_status_access_chk" CHECK (
    ("status" = 'pending' AND "effective_access" IS NULL AND "accepted_at" IS NULL)
    OR ("status" = 'active' AND "effective_access" IS NOT NULL AND "accepted_at" IS NOT NULL)
    OR ("status" = 'declined' AND "effective_access" IS NULL AND "accepted_at" IS NULL)
    OR "status" IN ('revoked', 'expired')
  ),
  CONSTRAINT "resource_shares_actor_refs_chk" CHECK (
    length(btrim("created_by_subject")) > 0
    AND length(btrim("created_by_acting_org_ref")) > 0
    AND length(btrim("source_external_org_id")) > 0
    AND length(btrim("source_external_team_id")) > 0
    AND length(btrim("recipient_external_org_id")) > 0
    AND length(btrim("recipient_external_team_id")) > 0
    AND (("accepted_by_subject" IS NULL AND "accepted_by_acting_org_ref" IS NULL AND "accepted_at" IS NULL)
      OR ("accepted_by_subject" IS NOT NULL AND "accepted_by_acting_org_ref" IS NOT NULL AND "accepted_at" IS NOT NULL))
    AND (("declined_by_subject" IS NULL AND "declined_by_acting_org_ref" IS NULL AND "declined_at" IS NULL)
      OR ("declined_by_subject" IS NOT NULL AND "declined_by_acting_org_ref" IS NOT NULL AND "declined_at" IS NOT NULL))
    AND (("revoked_by_subject" IS NULL AND "revoked_by_acting_org_ref" IS NULL AND "revoked_at" IS NULL)
      OR ("revoked_by_subject" IS NOT NULL AND "revoked_by_acting_org_ref" IS NOT NULL AND "revoked_at" IS NOT NULL))
  ),
  CONSTRAINT "resource_shares_terminal_actor_chk" CHECK (
    ("status" = 'declined') = ("declined_at" IS NOT NULL)
    AND ("status" = 'revoked') = ("revoked_at" IS NOT NULL)
    AND ("status" = 'expired') = ("expired_at" IS NOT NULL)
  ),
  CONSTRAINT "resource_shares_expiry_chk" CHECK (
    "expires_at" IS NULL OR "expires_at" > "created_at"
  ),
  CONSTRAINT "resource_shares_health_chk" CHECK (
    ("health" = 'healthy' AND "health_reason_code" IS NULL)
    OR ("health" = 'suspended' AND length(btrim("health_reason_code")) > 0)
  )
);

CREATE INDEX "resource_shares_recipient_team_id_status_expires_at_idx"
  ON "resource_shares"("recipient_team_id", "status", "expires_at");
CREATE INDEX "resource_shares_project_id_status_idx"
  ON "resource_shares"("project_id", "status");
CREATE INDEX "resource_shares_target_board_id_status_idx"
  ON "resource_shares"("target_board_id", "status");
CREATE INDEX "resource_shares_board_id_status_idx"
  ON "resource_shares"("board_id", "status");
CREATE INDEX "resource_shares_id_revision_idx"
  ON "resource_shares"("id", "revision");

-- Project scope has a NULL board id, so a normal nullable UNIQUE cannot prevent
-- duplicate pending/active offers. Separate partial indexes cover both scopes.
CREATE UNIQUE INDEX "resource_shares_live_project_recipient_key"
  ON "resource_shares"("project_id", "recipient_organization_id", "recipient_team_id")
  WHERE "scope" = 'project' AND "status" IN ('pending', 'active');
CREATE UNIQUE INDEX "resource_shares_live_board_recipient_key"
  ON "resource_shares"("target_board_id", "recipient_organization_id", "recipient_team_id")
  WHERE "scope" = 'board' AND "status" IN ('pending', 'active');

ALTER TABLE "resource_shares"
  ADD CONSTRAINT "resource_shares_source_organization_fkey"
  FOREIGN KEY ("source_organization_id", "source_external_org_id")
  REFERENCES "organizations"("id", "external_org_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "resource_shares_source_team_fkey"
  FOREIGN KEY ("source_team_id", "source_external_org_id", "source_external_team_id")
  REFERENCES "teams"("id", "external_org_id", "external_team_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "resource_shares_project_fkey"
  FOREIGN KEY ("project_id", "source_organization_id", "source_team_id")
  REFERENCES "projects"("id", "organization_id", "team_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "resource_shares_board_fkey"
  FOREIGN KEY ("board_id", "project_id", "source_organization_id")
  REFERENCES "boards"("id", "project_id", "organization_id")
  ON DELETE SET NULL ("board_id") ON UPDATE CASCADE,
  ADD CONSTRAINT "resource_shares_recipient_organization_fkey"
  FOREIGN KEY ("recipient_organization_id", "recipient_external_org_id")
  REFERENCES "organizations"("id", "external_org_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "resource_shares_recipient_team_fkey"
  FOREIGN KEY ("recipient_team_id", "recipient_external_org_id", "recipient_external_team_id")
  REFERENCES "teams"("id", "external_org_id", "external_team_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "board_share_publications" (
  "board_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_organization_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "board_share_publications_pkey" PRIMARY KEY ("board_id"),
  CONSTRAINT "board_share_publications_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "board_share_publications_board_fkey"
    FOREIGN KEY ("board_id", "project_id", "source_organization_id")
    REFERENCES "boards"("id", "project_id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "board_share_publications_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "board_share_publications_source_organization_id_fkey"
    FOREIGN KEY ("source_organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "board_share_publications_scope_key"
  ON "board_share_publications"("board_id", "project_id", "source_organization_id");
CREATE INDEX "board_share_publications_project_id_idx"
  ON "board_share_publications"("project_id");

CREATE TABLE "board_shared_fields" (
  "board_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_organization_id" UUID NOT NULL,
  "field_definition_id" UUID NOT NULL,
  "allowed_option_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "board_shared_fields_pkey" PRIMARY KEY ("board_id", "field_definition_id"),
  CONSTRAINT "board_shared_fields_option_ids_chk" CHECK (
    array_position("allowed_option_ids", '') IS NULL
  ),
  CONSTRAINT "board_shared_fields_publication_fkey"
    FOREIGN KEY ("board_id", "project_id", "source_organization_id")
    REFERENCES "board_share_publications"("board_id", "project_id", "source_organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "board_shared_fields_definition_fkey"
    FOREIGN KEY ("field_definition_id", "project_id", "source_organization_id")
    REFERENCES "task_field_definitions"("id", "project_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "board_shared_fields_project_id_source_organization_id_idx"
  ON "board_shared_fields"("project_id", "source_organization_id");

CREATE TABLE "board_shared_iterations" (
  "board_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_organization_id" UUID NOT NULL,
  "iteration_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "board_shared_iterations_pkey" PRIMARY KEY ("board_id", "iteration_id"),
  CONSTRAINT "board_shared_iterations_publication_fkey"
    FOREIGN KEY ("board_id", "project_id", "source_organization_id")
    REFERENCES "board_share_publications"("board_id", "project_id", "source_organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "board_shared_iterations_iteration_fkey"
    FOREIGN KEY ("iteration_id", "project_id", "source_organization_id")
    REFERENCES "iterations"("id", "project_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "board_shared_iterations_project_id_source_organization_id_idx"
  ON "board_shared_iterations"("project_id", "source_organization_id");

CREATE TABLE "board_shared_resources" (
  "board_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_organization_id" UUID NOT NULL,
  "page_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "board_shared_resources_pkey" PRIMARY KEY ("board_id", "page_id"),
  CONSTRAINT "board_shared_resources_publication_fkey"
    FOREIGN KEY ("board_id", "project_id", "source_organization_id")
    REFERENCES "board_share_publications"("board_id", "project_id", "source_organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "board_shared_resources_page_fkey"
    FOREIGN KEY ("page_id", "project_id", "source_organization_id")
    REFERENCES "knowledge_pages"("id", "project_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "board_shared_resources_project_id_source_organization_id_idx"
  ON "board_shared_resources"("project_id", "source_organization_id");

-- Revisions are durable invalidation fences. Every row update must advance the
-- grant revision; health changes additionally advance their own revision.
CREATE FUNCTION "enforce_resource_share_revision_monotonic"()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."id",
    NEW."scope",
    NEW."source_organization_id",
    NEW."source_external_org_id",
    NEW."source_team_id",
    NEW."source_external_team_id",
    NEW."project_id",
    NEW."target_board_id",
    NEW."recipient_organization_id",
    NEW."recipient_external_org_id",
    NEW."recipient_team_id",
    NEW."recipient_external_team_id",
    NEW."created_by_subject",
    NEW."created_by_acting_org_ref",
    NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."id",
    OLD."scope",
    OLD."source_organization_id",
    OLD."source_external_org_id",
    OLD."source_team_id",
    OLD."source_external_team_id",
    OLD."project_id",
    OLD."target_board_id",
    OLD."recipient_organization_id",
    OLD."recipient_external_org_id",
    OLD."recipient_team_id",
    OLD."recipient_external_team_id",
    OLD."created_by_subject",
    OLD."created_by_acting_org_ref",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'resource share identity, target, audience and creation audit are immutable';
  END IF;

  IF OLD."declined_at" IS NOT NULL
     AND (NEW."declined_by_subject", NEW."declined_by_acting_org_ref", NEW."declined_at")
       IS DISTINCT FROM
       (OLD."declined_by_subject", OLD."declined_by_acting_org_ref", OLD."declined_at") THEN
    RAISE EXCEPTION 'resource share decline audit is append-only';
  END IF;

  IF OLD."revoked_at" IS NOT NULL
     AND (NEW."revoked_by_subject", NEW."revoked_by_acting_org_ref", NEW."revoked_at")
       IS DISTINCT FROM
       (OLD."revoked_by_subject", OLD."revoked_by_acting_org_ref", OLD."revoked_at") THEN
    RAISE EXCEPTION 'resource share revocation audit is append-only';
  END IF;

  IF OLD."expired_at" IS NOT NULL
     AND NEW."expired_at" IS DISTINCT FROM OLD."expired_at" THEN
    RAISE EXCEPTION 'resource share expiry audit is append-only';
  END IF;

  IF (NEW."accepted_by_subject", NEW."accepted_by_acting_org_ref", NEW."accepted_at")
       IS DISTINCT FROM
       (OLD."accepted_by_subject", OLD."accepted_by_acting_org_ref", OLD."accepted_at")
     AND (
       NEW."effective_revision" IS NULL
       OR (
         OLD."effective_revision" IS NOT NULL
         AND NEW."effective_revision" <= OLD."effective_revision"
       )
     ) THEN
    RAISE EXCEPTION 'resource share acceptance audit changes require a higher effective revision';
  END IF;

  -- PostgreSQL implements the board FK's column-scoped SET NULL as an UPDATE.
  -- Preserve the same invalidation fence when a terminal share loses its live
  -- ancestry link during board deletion.
  IF OLD."board_id" IS NOT NULL
     AND NEW."board_id" IS NULL
     AND OLD."status" IN ('declined', 'revoked', 'expired')
     AND NEW."status" IN ('declined', 'revoked', 'expired')
     AND NEW."revision" = OLD."revision" THEN
    NEW."revision" := OLD."revision" + 1;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;

  IF NEW."revision" <= OLD."revision" THEN
    RAISE EXCEPTION 'resource share revision must increase';
  END IF;

  IF NEW."health_revision" < OLD."health_revision" THEN
    RAISE EXCEPTION 'resource share health revision cannot decrease';
  END IF;

  IF (NEW."health", NEW."health_reason_code") IS DISTINCT FROM
     (OLD."health", OLD."health_reason_code")
     AND NEW."health_revision" <= OLD."health_revision" THEN
    RAISE EXCEPTION 'resource share health transition must increase health revision';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "resource_shares_revision_monotonic_trg"
BEFORE UPDATE ON "resource_shares"
FOR EACH ROW EXECUTE FUNCTION "enforce_resource_share_revision_monotonic"();

CREATE FUNCTION "enforce_board_share_publication_revision_monotonic"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."revision" <= OLD."revision" THEN
    RAISE EXCEPTION 'board share publication revision must increase';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "board_share_publications_revision_monotonic_trg"
BEFORE UPDATE ON "board_share_publications"
FOR EACH ROW EXECUTE FUNCTION "enforce_board_share_publication_revision_monotonic"();

-- Projection membership and option changes alter the external audience. Bump
-- the owning policy inside the same database statement so no writer can forget
-- the invalidation fence. An UPDATE that moves a row bumps both owners.
CREATE FUNCTION "bump_board_share_publication_revision"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "board_share_publications"
    SET "revision" = "revision" + 1,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "board_id" = NEW."board_id";
    RETURN NEW;
  END IF;

  UPDATE "board_share_publications"
  SET "revision" = "revision" + 1,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "board_id" = OLD."board_id";

  IF TG_OP = 'UPDATE' THEN
    IF NEW."board_id" <> OLD."board_id" THEN
      UPDATE "board_share_publications"
      SET "revision" = "revision" + 1,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "board_id" = NEW."board_id";
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "board_shared_fields_bump_publication_revision_trg"
AFTER INSERT OR UPDATE OR DELETE ON "board_shared_fields"
FOR EACH ROW EXECUTE FUNCTION "bump_board_share_publication_revision"();

CREATE TRIGGER "board_shared_iterations_bump_publication_revision_trg"
AFTER INSERT OR UPDATE OR DELETE ON "board_shared_iterations"
FOR EACH ROW EXECUTE FUNCTION "bump_board_share_publication_revision"();

CREATE TRIGGER "board_shared_resources_bump_publication_revision_trg"
AFTER INSERT OR UPDATE OR DELETE ON "board_shared_resources"
FOR EACH ROW EXECUTE FUNCTION "bump_board_share_publication_revision"();
