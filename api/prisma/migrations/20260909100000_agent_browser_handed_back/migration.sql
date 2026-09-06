-- Who last handed a browser back, and when.
--
-- The sign-in hand-over lets an agent pick a signed-in browser up again after
-- a person finishes with it. That permission is recorded here rather than on
-- the waking run: a kickoff that has to queue behind an in-flight run is
-- batched into a follow-up, and a payload field is lost on that path while a
-- column survives it. The timestamp is what keeps the permission from being
-- indefinite — a wake job sitting in a backlog must not still be a key hours
-- later.
ALTER TABLE "agent_browsers"
  ADD COLUMN "handed_back_by_user_id" UUID,
  ADD COLUMN "handed_back_at" TIMESTAMP(3);

-- Both or neither: a hand-back without its moment cannot be aged out, and a
-- moment without its person cannot be matched to one.
ALTER TABLE "agent_browsers"
  ADD CONSTRAINT "agent_browsers_handed_back_chk" CHECK (
    ("handed_back_by_user_id" IS NULL) = ("handed_back_at" IS NULL)
  );
