-- A raw native push token identifies an installation but does not prove that
-- the caller controls it. The hash is an installation-held transfer proof;
-- existing active rows are provisioned on their next same-owner registration.
ALTER TABLE "device_tokens" ADD COLUMN "ownership_proof_hash" TEXT;
