# Executor management reads and agent access

The executor detail surface owns **Agents**, **Permissions**, and **Activity**.
Its doorway is the executor list; the navigation badge points to machines whose
latest local policy proposal awaits a decision the current person may make.

`GET /api/executors/:executorId/agents` lists agents with an explicit private
assignment or at least one currently allowed operation grant on that executor.
`GET /api/executors/:executorId/agent-candidates` lists eligible tool-policy
targets not already in that set. Both require executor management permission,
apply the existing agent privacy boundary, exclude deleted agents, and apply
`q` search before computing the total. Organisation ownership does not expose
another person's private agent. Candidate eligibility matches the existing
tool-policy target kinds: ordinary shared agents and Personal Assistants.

Both routes accept `PaginationParams` plus `q`, return the standard `data` and
`PaginationMeta` envelope with `total`, and use immutable creation time plus id
for a stable keyset. Cursors are opaque to clients. Each row contains
`agentId`, `name`, `visibility`, `assigned`, and `allowedOperationKeys`.
`assigned` reports the explicit private roster entry; stored allowed keys do
not assert runtime readiness. Machine status, reviewed policy, the requesting
human, the agent's logical tool policy, and run scope remain separate gates.
Denied-only grant history does not keep a removed agent in the current list.

The prepared change `{kind: "agent_executor_access", agentId, state}` combines
private roster membership and the existing whole-suite grant. Allow adds both;
deny withdraws both. Project and organisation executors use the existing
whole-suite grant alone. All writes and continuation consumption share one
transaction. The per-agent logical tool policy update runs after continuation
validation in that same transaction; invalid, expired, rejected, or stale
confirmations cannot alter it. The agent policy lock also covers the read of
grants held on other executors, so concurrent changes cannot disable a policy
the agent still holds elsewhere. The existing authorization checks,
per-mutation connection fences, and audit events remain in force.
Failure to grant rolls the new private assignment back. Removing one agent
does not remove another agent's grants on the same machine.

Fresh verification is still required for allowing access and for private
roster changes, including removal. The access-change GET response adds
`verificationMethod: "password" | "unavailable"`, derived from the same factor
availability as the existing confirmation guard. It lets the review explain
when verification cannot be completed; it does not introduce an SSO proof or
weaken the confirmation requirement.

`GET /api/executors/attention` returns `{total, executors}`, with one
`{executorId, policyRevision}` per manageable machine whose absolute latest
revision is `pending_review`. Pending pairing and revoked machines are excluded.
Superseded pending revisions, disabled/active policies, and historical workspace
review receipts contribute nothing. Workspace receipts have no resolved or
actionable-state projection and therefore must not be counted as outstanding
decisions. The summary reveals no policy contents or other people's private
machines. The existing navigation `badgeCount` and detail `TabBar.count` render
the summary without fetching every machine's management payload.
