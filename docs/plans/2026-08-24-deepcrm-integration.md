# DeepCRM integration

DeepCRM is a first-party, team-enabled CRM tool product. Nessie exposes it to
agents through the existing managed MCP connector path: a team owner enables the
product, Nessie provisions one team-scoped tool-projecting instance, and worker
runs call DeepCRM with Nessie's app proof plus the linked user's UOA delegation.

Authoritative DeepCRM-side contract:
[`deepcrm.live/docs/mcp-surface.md`](../../../deepcrm.live/docs/mcp-surface.md)
and
[`deepcrm.live/docs/spec/nessie-integration.md`](../../../deepcrm.live/docs/spec/nessie-integration.md).

## Product row and catalog

- Add an `IntegratedProduct` row with slug `deepcrm`, category `tool`, and
  product identity mode `uoa_sso`.
- Add the canonical first-party public MCP catalog entry `deep-crm`, owned by
  the integration and hidden from generic catalog mutation. Its endpoint is
  exactly `https://api.deepcrm.live/mcp`.
- The managed instance uses bearer auth from deployment environment variable
  `DEEPCRM_MCP_APP_KEY`. This is a DeepCRM-issued, Nessie-only app key and must
  not be reused as an ordinary connector credential, per-org webhook secret, or
  per-user OAuth token.
- Startup should reject ambiguous credential reuse the same way the DeepSignal
  path rejects reuse of `DEEPSIGNAL_MCP_APP_KEY`.

## Team enablement

Owner-only team enablement provisions a team-scoped, tool-projecting
`McpServerInstance` from the `deep-crm` catalog entry. Enablement probes
`tools/list` under the enabling owner's current UOA delegation and projects
DeepCRM tools as `mcp_crm_*`, for example `crm_record_assert` becomes
`mcp_crm_record_assert`.

The connector lifecycle is integration-managed:

- generic instance create, delete, refresh, probe, and secret writes refuse the
  DeepCRM instance with the existing managed-product error shape;
- disable removes the team-scoped instance and projected registry rows, but does
  not delete DeepCRM tenant data;
- re-enable reconnects to the same UOA team tenant through DeepCRM's first-call
  provisioning path;
- every enable, disable, and grant mutation uses the team transition lock so a
  concurrent run cannot observe a half-provisioned toolset.

## Call authentication and identity

Every MCP call to DeepCRM carries three independent proofs:

- `Authorization: Bearer ${DEEPCRM_MCP_APP_KEY}` authenticates Nessie as the
  calling product.
- `X-UOA-Delegation` is a short-lived `ai.invoke` delegation for the linked
  user and active UOA organization/team. It is minted through UOA's
  confidential assertion exchange, not stored in Nessie as a reusable DeepCRM
  credential.
- `X-Nessie-Context` is Nessie's fresh RS256 provenance assertion with non-null
  user, org, team, agent, run, request, and tool-call provenance. Existing
  caller-supplied identity headers are rejected before Nessie attaches its own.

The selected Nessie team must map exactly to the signed UOA team. A missing or
stale UOA link fails closed; there is no fallback local identity or per-user
DeepCRM login.

## Tool exposure and grants

DeepCRM tools are default ON for team agents because CRM reads and normal
write/update operations are unmetered, reversible, and policy-checked by
DeepCRM. Nessie's per-agent tool policy remains an additional exposure gate and
never bypasses DeepCRM tenancy, visibility, policy, or approval checks.

The following projected tools are default ON when their team-scoped instance
reaches the run:

- read/query/discovery tools, including schema, records, links, lists, views,
  activities, timelines, tasks, pipeline, search, change-feed, data-quality,
  duplicate scan, suppression check/list/add, and webhook list;
- ordinary CRM writes, including record create/update/assert, link/unlink,
  activity log, note add, task create/update, list/view mutation, and
  suppression add.

The following projected tools are flagged `requiresExplicitGrant` and default
OFF until a team owner grants them to one exact agent:

- destructive or irreversible record/compliance tools:
  `crm_merge_records`, `crm_unmerge`, `crm_record_delete`,
  `crm_record_erase`, `crm_suppression_remove`, and
  `crm_write_guard_set`;
- offline/export and integration-control tools: `crm_export`,
  `crm_webhook_set`, and `crm_webhook_delete`;
- structural/schema tools: `crm_object_type_define`,
  `crm_object_type_update`, `crm_object_type_archive`,
  `crm_attribute_define`, `crm_attribute_update`, `crm_attribute_archive`,
  `crm_relation_type_define`, `crm_relation_type_archive`,
  `crm_matching_rule_set`, and `crm_template_apply`.

The read that resolves an id ships with any granted mutator. Owner grants use
the same targeted tool-policy route and per-agent lock as other managed
first-party tools, preserving unrelated allow/deny entries.

## MRTR approvals

DeepCRM may return an MCP result with `resultType: "input_required"` plus
standard `elicitation/create` requests and an opaque `requestState`. The worker
treats this as a normal tool result, not as a transport error.

When the agent needs approval:

1. The agent asks in the channel and Nessie may mirror the prompt into an
   `ApprovalRequest` with action `deepcrm:<tool>`.
2. An authorized admin or owner approves or rejects in Nessie.
3. On approval, Nessie re-issues the same `tools/call` with the preserved
   `requestState` and `inputResponses`, under the approving human's
   `X-UOA-Delegation`.
4. DeepCRM verifies the state, the approver role, and the stored argument
   snapshot before executing.

Expired or rejected approvals are terminal for that attempt and require the
agent to start a fresh tool call.

## Webhooks and digest

For each enabled team, Nessie's integration code registers a DeepCRM webhook
with `crm_webhook_set` under an owner delegation:

- target URL:
  `https://api.nessie.works/api/integrations/deepcrm/events`;
- envelope: DeepCRM `deepcrm.webhook.v1`;
- secret storage: encrypted per org through
  `PUT /api/integrations/products/deepcrm/webhook-secret`;
- verification: timestamp plus HMAC, with idempotency by DeepCRM sequence.

Webhook delivery creates or updates one rolling DeepCRM digest message in the
team's product channel, following the DeepSignal delivery shape rather than
posting one message per CRM event. The digest summarizes useful counts such as
changed records, deal stage moves, added people, erased records, or webhook
delivery errors. Scheduled automation should use `mcp_crm_changes_since` with a
cursor persisted in trigger state for catch-up.

## Prompts

Nessie may expose DeepCRM prompts as product skills. Prompt bodies reference the
projected `mcp_crm_*` tool names, and installation rewrites DeepCRM's `crm_*`
prompt references to those projected names. Prompt text must not weaken
server-side gates: merge, delete, export, schema, suppression removal, and
erasure remain enforced by DeepCRM policy and MRTR approval.

## Implementation notes

- Reuse `@nessie/mcp-manage` for catalog resolution, transport construction,
  projection, credential handling, and `callInstanceTool`.
- Use the existing managed-product lifecycle pattern rather than generic
  connector paths.
- Keep DeepCRM disabled until the owner review of this plan is complete.
- T47's real-agent smoke requires production DeepCRM credentials and remains a
  human gate.
