-- Instance-level login branding gets an explicit owner.
--
-- `GET /api/brand/logo` is public and unauthenticated: it paints the sign-in
-- screen for everybody on the instance. It used to serve "the organisation's
-- logo, if the instance holds exactly one organisation", which had two faults
-- once one Nessie `Organization` per UOA organisation landed:
--   * with N organisations it 404s, so branding silently stopped working;
--   * with exactly one it let that tenant's admins control the unauthenticated
--     screen shown to everyone reaching the instance.
-- The sign-in screen is instance state, so the instance operator designates
-- which organisation's mark it carries (`nessie set-instance-brand <orgId>` /
-- `clear-instance-brand` / `show-instance-brand`, the same out-of-band CLI that
-- grants `User.superAdmin`). No organisation designated = Nessie's own mark.
--
-- Backfill preserves existing behaviour exactly where it was well-defined: a
-- single-organisation instance (a local / self-hosted install, where the
-- organisation IS the instance) keeps serving its logo. A multi-organisation
-- instance designates none, which is what it was already doing.
ALTER TABLE "organizations"
  ADD COLUMN "instance_brand" BOOLEAN NOT NULL DEFAULT false;

UPDATE "organizations"
SET "instance_brand" = true
WHERE (SELECT count(*) FROM "organizations") = 1;
