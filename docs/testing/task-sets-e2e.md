# Task Sets browser contract

Task Sets lives at **Agents → Task Sets** (`/agents/task-sets`). The same
detail address opens an agent-created workload, a task-set health alert, or
a workload created from Documents. A supported uploaded file's **Process with
Task Set** action pins its page, version and format in the creation form.

The processor dropdown lists the server's authorized model options. Local
models require the exact existing binding; a setup doorway does not grant
access. A receiver is optional and separately names an agent, a conversation
and continuation instructions. Each set stays sequential. Local resource
capacity and pause controls reuse `LocalInferenceHostStatus`, so changing
shared capacity affects all sets on that resource without changing item order.
The form also exposes the request limit shared across sets for hosted and local
processors; editing other settings retains that configured limit.

Manual tasks can depend on earlier items. File inputs specify record selection
against a pinned version. Results remain readable on paginated item detail,
with optional files or a new Excel artifact in a chosen Documents space/folder.
Configuration drafts survive navigation. Paused sets remain locked while their
current item is stopping; uncertainty about local termination points to recovery
on the computer and cannot be dismissed by Resume.

Run the headless browser contract in a checkout with installed workspace
dependencies and built shared packages:

```sh
pnpm --filter @nessie/admin test:e2e:task-sets
```

The harness resolves this worktree's `NESSIE_API_PORT` and `NESSIE_ADMIN_PORT`,
refuses an occupied pair, starts its own Vite server, and stops only that server.
Set the pair before the run when the defaults are occupied. For a CI preview
build, set `NESSIE_TASK_SETS_E2E_FIXTURE=1`; ordinary production builds omit
the fixture entry.

The fixture renders the production pages, facade mutations, form schemas,
navigation primitives and local host controls. Its transport and worker events
are controlled test data. It proves request wiring and user-visible behavior;
it does **not** prove database durability, real LLM execution, authorization,
row ingestion, search evidence or artifact publication. Those belong to the
API, source-adapter and worker integration suites.

The durable browser scenarios cover:

- Separate processor and optional receiver; unavailable unbound model setup;
  draft restoration and a sequential create payload.
- Manual items with a prerequisite, start/pause, independent shared-host pause,
  shared capacity changes and a rejected resume with the server's actual remedy.
- Pinned XLSX input, row range, new output spreadsheet mapping and an explicit
  receiver conversation.
- Two-page item navigation, failed dependency/context explanation, explicit skip,
  offline waiting, stopped-item editing guard, and uncertain local termination.
- Saved result text without a receiver, output-delivery retry without rerunning
  items, and the Task Sets home at desktop and phone widths.

Screenshots are written to the ignored `e2e/screenshots/task-sets/` directory.
Inspect them after the run; an exit code alone is not visual verification.
