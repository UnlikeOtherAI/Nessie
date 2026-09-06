# BuildMe Board Source Contract

Status: planned contract.

Nessie can link out to buildme.live through UOA SSO today. Native BuildMe board
rendering must stay read-only and blocked until BuildMe publishes a project-board
API or MCP server with the fields below.

## Pairing Model

Nessie pairs one active Nessie project to one BuildMe board source:

```text
Nessie project id
BuildMe workspace/team id
BuildMe board id
sync mode: read_only
column mapping: BuildMe column id -> Nessie column id
assignee mapping: BuildMe user id -> Nessie user id
conflict policy: external_source_wins | manual_review
```

Do not create bidirectional writes in the first native version. BuildMe remains
the source of truth for external board state; Nessie renders a projected view.

## Required BuildMe API/MCP Surface

Minimum read endpoints or MCP tools:

- list teams/teams visible to the UOA active user;
- list boards for a team/team;
- read one board with ordered columns;
- read cards for one board with pagination or cursor support;
- read card fields: id, title, description summary, column id, status, priority,
  assignees, labels, due date, updated timestamp, created timestamp;
- read users/members for assignee mapping;
- expose stable external ids and `updatedAt` timestamps for incremental sync.

Optional later endpoints:

- write card column changes after explicit admin enablement;
- write assignee/status changes only after assignee mapping is confirmed;
- webhook or event cursor for board changes.

## Nessie Projection Rules

- Store external ids and sync cursors as project metadata or a dedicated pairing
  table before rendering native columns.
- Render read-only columns first. Each native card must show that BuildMe is the
  source.
- Keep unmapped columns visible as external columns; do not silently merge them.
- Put conflict resolution behind an explicit review state.
- Do not import team files, shell history, secrets, or raw development
  environment content as part of board sync.

## ESC Readiness States

- `link-handoff`: available now through UOA SSO and Personal Assistant handoff.
- `project-source-pairing`: planned until the API/MCP surface exists.
- `column-mapping` and `conflict-policy`: blocked until a board payload can be
  inspected safely.
