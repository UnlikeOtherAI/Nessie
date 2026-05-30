-- Convert the free-text membership `role` columns on organization_members,
-- project_members, and team_members to a MemberRole enum so the database
-- enforces the same vocabulary the API already validates (owner/admin/member/
-- viewer). channel_members has no role column and is untouched.
--
-- VALUE GUARD: before applying, confirm every existing role is in the enum:
--   SELECT 'organization_members' t, role FROM organization_members
--     WHERE role NOT IN ('owner','admin','member','viewer')
--   UNION ALL SELECT 'project_members', role FROM project_members
--     WHERE role NOT IN ('owner','admin','member','viewer')
--   UNION ALL SELECT 'team_members', role FROM team_members
--     WHERE role NOT IN ('owner','admin','member','viewer');
-- Must return zero rows; otherwise map the stray values first.

CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- The text default must be dropped before the column type can change, then the
-- enum default re-applied.
ALTER TABLE "organization_members" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "organization_members"
  ALTER COLUMN "role" TYPE "MemberRole" USING "role"::"MemberRole";
ALTER TABLE "organization_members" ALTER COLUMN "role" SET DEFAULT 'member';

ALTER TABLE "project_members" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "project_members"
  ALTER COLUMN "role" TYPE "MemberRole" USING "role"::"MemberRole";
ALTER TABLE "project_members" ALTER COLUMN "role" SET DEFAULT 'member';

ALTER TABLE "team_members" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "team_members"
  ALTER COLUMN "role" TYPE "MemberRole" USING "role"::"MemberRole";
ALTER TABLE "team_members" ALTER COLUMN "role" SET DEFAULT 'member';
