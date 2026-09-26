# Native Task Set tools

Task Sets has one human surface at **Admin › Automations › Batch jobs**. Native Nessie agents
reach the same service through the `task_set_*` builtins; every returned workload
includes its `/agents/task-sets/:id` address as the conversation doorway. Agents
return that link when a person needs to inspect progress or change a workload.

The processor does the work. The optional receiver names a separate agent and
an explicit authorized conversation for subsequent processing. A set always
processes one item at a time. Dependencies reference earlier items and do not
make execution parallel. Shared resource capacity is a separate admission limit.

| Tool | Purpose |
| --- | --- |
| `task_set_processors` | Resolve authorized model choices and exact local bindings. |
| `task_set_list`, `task_set_read` | Read owned sets, progress, reasons and configuration. |
| `task_set_items`, `task_set_item_read` | Page through ordered item metadata and complete prompt/input/result content. |
| `task_set_create` | Create a draft with a pinned document version or a small manual batch. |
| `task_set_update` | Patch changed configuration fields while stopped. |
| `task_set_add_items`, `task_set_update_item` | Append idempotent manual items or edit unfinished stopped items. |
| `task_set_control` | Start, pause, resume, cancel, retry or explicitly skip. |

For a large spreadsheet, create one source selection rather than generating a
model-authored task list. The deterministic importer owns the row cursor. The
agent gives the processor its objective, instructions and output mapping, then
starts the set. It does not stay in a model loop polling the workload.

List calls return at most twenty concise records and server cursors. Detailed
configuration is JSON text in `configuration.text`, with the next offset in
`configuration.page.nextOffset`. An item read selects `result`, `input` or
`prompt` (or `metadata` for the complete reason/locator), returning `text` and
`page.nextOffset`. Follow those offsets until
null; chunks also budget JSON escaping so large results remain recoverable
through the normal tool-output limit. Result journal storage does not require
a receiver or publication into Documents.

The runtime passes its existing authorized actor context to `@nessie/team-admin`.
Each operation rechecks the responsible person's live entitlement. No tool
argument supplies a human identity, disclosure basis or originating conversation:
create stamps the current run's thread and triggering message. An autonomous
agent without a responsible human cannot acquire one through these tools.

Every content-bearing shared reader observes the set, item input and result
disclosures before returning content. A pinned source also rechecks current
document authority for both the human and the actual reading agent, including
human-only spaces, restricted pages and another agent's private pages. Native
calls obtain that agent from the trusted tool actor context. Human UI access
continues to use the human's own authority; denied list entries expose no name.
The worker feeds their exact scopes and
private author lineage into the run's consumed-source sink. A missing sink fails
before any read or mutation. Create and content edits monotonically union the
trusted run lineage with existing set/item/source lineage; a model cannot reset
that boundary. The API uses these same readers and mutation functions.

These are native Nessie tools. Existing paired MCP clients gain no execution
authority from their board or document scopes. Exposing Task Sets to paired
clients requires a separately designed and explicitly authorized scope.

The browser contract is documented in
[Task Sets browser verification](../testing/task-sets-e2e.md). Shared disclosure
tests cover revoked inputs, complete read observation and idempotent lineage;
worker tool tests cover identity rejection, missing sinks and complete paged
result reconstruction.
