-- The UOA workspace directory (workspace labels, org ids/names, avatar URLs) is
-- UnlikeOtherAI-owned identity data. It is now held only in the API's bounded
-- in-memory cache, so drop the durable mirror from existing account links.
-- Every other metadata key (provider, teamIds, teamRoles, orgRole, per-product
-- integration state) is left untouched.
UPDATE "product_account_links"
SET "metadata_json" = "metadata_json" - 'workspaceDirectory'
WHERE jsonb_typeof("metadata_json") = 'object'
  AND jsonb_exists("metadata_json", 'workspaceDirectory');
