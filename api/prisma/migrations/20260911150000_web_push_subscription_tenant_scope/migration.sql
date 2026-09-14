-- A PushSubscription belongs to the browser, while this row is a tenant/user
-- enrollment of it. The same browser endpoint may therefore serve the same
-- person in more than one organization.
DROP INDEX "web_push_subscriptions_user_id_endpoint_key";

CREATE UNIQUE INDEX "web_push_subscriptions_organization_id_user_id_endpoint_key"
ON "web_push_subscriptions"("organization_id", "user_id", "endpoint");
