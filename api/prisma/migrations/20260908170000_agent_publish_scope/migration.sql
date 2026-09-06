-- Publishing is its own agent scope.
--
-- "Agents draft; only a human may publish" is already enforced for Nessie's own
-- agents: the publish route refuses an `agent` actor outright and sends it to an
-- approval. An MCP agent credential resolves as the human who approved it, so
-- that check does not catch it — the rule would be bypassed by an actor it was
-- written for.
--
-- Rather than drop the rule or refuse publication forever, the decision becomes
-- the human's, once and revocably: `documents_publish` is granted only by
-- explicitly ticking it while approving a pairing, and it is deliberately NOT
-- pre-selected the way the other scopes are.

ALTER TYPE "AgentAccessScope" ADD VALUE IF NOT EXISTS 'documents_publish';

-- The approving human's UOA workspace, captured while a real session exists.
--
-- A credential has no session, and the work an agent starts can outlive the
-- call: creating a document enqueues an embedding job whose Ledger call, on a
-- signing deployment, needs the originating person's UOA identity. The account
-- link proves subject/status/epoch but not which workspace they were acting in.
-- Without this the tool reports success and the indexing fails later, in the
-- background, where nobody is looking — the same failure shape scheduled
-- triggers hit before they captured `launchOrigin.uoaIdentity`.
ALTER TABLE "agent_access_credentials" ADD COLUMN "uoa_identity" JSONB;

-- Carried from the approval onto the credential it mints.
ALTER TABLE "agent_authorization_requests"
  ADD COLUMN "approved_uoa_identity" JSONB;
