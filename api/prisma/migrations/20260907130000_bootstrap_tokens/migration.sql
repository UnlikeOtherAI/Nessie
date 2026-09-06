-- The install's owner-bootstrap token, shared by every API replica.
--
-- It used to be minted per process with `randomUUID()` and held in a closure
-- (horizontal-scaling audit 1.2): each replica logged a different setup URL
-- and an exchange that landed anywhere else failed TOKEN_INVALID.
--
-- Single row by construction: `id` is always 'singleton', so the primary key
-- is what stops a second token existing; the `nessie:bootstrap-initialization`
-- advisory lock every writer takes only decides which replica writes it. The
-- token is stored raw rather than hashed — every replica prints the whole
-- setup URL to its own log at boot, the install has zero users for as long as
-- the row is usable, and the row lives fifteen minutes and is consumed exactly
-- once by a conditional UPDATE inside the transaction that creates the owner.
CREATE TABLE "bootstrap_tokens" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bootstrap_tokens_pkey" PRIMARY KEY ("id")
);
