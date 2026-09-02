-- `ToolGrantSource` stored 'agent-override' (kebab), while
-- `20260901200000_tool_grant_principal_integrity` — already committed, and
-- immutable — repairs historic rows with `WHERE "source" = 'agent_override'`
-- (snake). Postgres casts that literal to the enum at plan time, so the
-- statement fails with 22P02 no matter how many rows exist. That migration has
-- therefore NEVER applied anywhere: `prisma migrate deploy` stops there on
-- every fresh database and on the upgrade-path baseline alike.
--
-- Renaming the value is the smallest correct repair, and it runs BEFORE that
-- migration so its statement becomes valid and does exactly what its author
-- wrote it to do. Nothing else moves: `@map("agent-override")` only ever
-- controlled the bytes Postgres stores, and the wire contract is a separate
-- mapping (`@nessie/mcp-manage` tool-enum-mapping.ts) between the public
-- 'agent-override' string and Prisma's `agent_override` client name, which was
-- already snake_case. External callers see no change.
--
-- Ordering is safe precisely because the broken migration always failed: no
-- database can be past it, so nothing applied after this point is being
-- reordered. A database parked on the failure needs the documented
-- `prisma migrate resolve --rolled-back 20260901200000_tool_grant_principal_integrity`
-- once, after which deploy replays this migration and then succeeds.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    WHERE pg_type.typname = 'ToolGrantSource'
      AND pg_enum.enumlabel = 'agent-override'
  ) THEN
    ALTER TYPE "ToolGrantSource" RENAME VALUE 'agent-override' TO 'agent_override';
  END IF;
END
$$;
