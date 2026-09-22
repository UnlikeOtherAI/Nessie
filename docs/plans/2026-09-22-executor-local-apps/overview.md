# Executor local apps: a machine, a coding session and a browser an agent can drive

Status: plan, 2026-09-22. Evidence came from a live usability run
([docs/testing/cto-agent-usability-2026-09-22.md](../../testing/cto-agent-usability-2026-09-22.md))
and from four adversarial reviews of the first draft (security, process
robustness on every OS, agent experience, codebase fit). Every decision below
answers a finding from one of them.

## The goal

A person talks to an agent (the CTO of a project) in a Nessie conversation.
Through the person's paired executor the agent can:

1. **Drive programs on that machine** that its owner named in the reviewed
   policy — the existing local-MCP transport (`mcp.tools` + `mcp.call`).
2. **Instruct and interactively drive a local coding-agent session** — Claude
   Code as the CLI user is logged in, or Codex — start it with a task, follow
   up, watch its progress, interrupt it, review what it changed, close it. The
   agent never writes the code itself.
3. **Drive the Kelpie browser** on that machine and **see its screenshots** as
   vision input, to evaluate sites.

It works on Windows, macOS and Linux executors, and it is a conversation: the
person's own follow-ups keep the same reach until they end it.

## Table of Contents

| Chapter | Ships as | What it settles |
|---|---|---|
| [lane-and-presentation.md](lane-and-presentation.md) | PR 1 | Launching local apps from the UI, a Stop control, timing that cannot abort a run, per-server failure accounting, argument coercion, results shaped for the model, the disclosure rule for host app output |
| [conversation-lease.md](conversation-lease.md) | PR 2 | How a person's own follow-ups keep the executor, structurally, without letting anyone or anything else borrow it |
| [coding-sessions.md](coding-sessions.md) | PR 3a (executor) and 3b (control plane) | The `coding-sessions` bridge, its session host, containment and teardown per OS, owner isolation, the reviewed descriptor, the agent's first-class tools |
| [screenshots.md](screenshots.md) | PR 4 | Images from local apps stored through `FileService`, shown to the model through the one prompt-image loader, and to the person in the thought-process view |
| [setup-flow.md](setup-flow.md) | PR 5 | The agent-building problems met on the way: ticket tools, project id, recalled memory blocking writes, a channel per agent, the grant link, portraits, voice |
| [verification.md](verification.md) | all | Test matrix per OS, CI additions, and the live acceptance script |

PR 1 and PR 5 are independent. PR 2 builds on PR 1's launcher. PR 3a is
executor-only and can be built beside PR 1; PR 3b needs PR 1 and PR 2. PR 4
needs PR 1. They merge in the order 1, 5, 2, 3a, 3b, 4, each green on its own.

## Decisions that change a documented invariant

Each amendment ships in the same PR as the code, in the file named.

1. **Binding** — [docs/executor-protocol/overview.md](../../executor-protocol/overview.md)
   "a human must bind one opaque candidate to the exact run" gains the lease
   clause and its structural definition of *initiated by that person*
   (PR 2, new chapter `docs/executor-protocol/conversation-leases.md`).
2. **Host-local coding bridge in the trust table** — the protocol's rules that
   the coding CLI never reaches host files or credentials, that there is no
   prompt channel, and that host writes happen only by promotion, are scoped to
   guest work. A new row names the exception: *an owner-named host-local
   coding bridge acts with the host OS user's full authority*. It is only
   offered on a **private** executor and only to runs whose initiating person
   is that executor's **pairing owner** (PR 3, new chapter
   `docs/executor-protocol/host-coding-sessions.md`;
   [full-actuation §7–§8](../2026-08-31-executor-full-actuation.md) records the decision).
3. **Host app output is privileged, not public web** — full-actuation §9's
   premise that executor reads are allowlisted public pages no longer holds
   for `mcp.call`. Launching local apps in a conversation is the person's
   consent to show that machine's app output to that conversation's audience,
   and nowhere else; every `mcp.*` result stamps the run's disclosure basis
   with the launch conversation's scope (PR 1,
   [disclosure-boundaries.md](../../standards/disclosure-boundaries.md)).
4. **Reserved `_meta`** — the daemon still passes the model's `arguments`
   untouched, and additionally sets reserved `_meta` keys the model cannot
   reach (`nessie/owner`, `nessie/command`, `nessie/daemon-control`) on calls
   to the built-in bridge only (PR 3a,
   [executor-local-mcp.md](../../standards/executor-local-mcp.md)).
5. **Screenshots are files** — images from local apps go through `FileService`
   with accounting and quota, linked to their executor command, and reach
   prompts only through `worker/src/run/message-attachments.ts` (PR 4,
   [file-storage.md](../../standards/file-storage.md)).

## What deliberately does not change

- The VM guest `coding.*` lane, its egress gateway and its single-prompt Codex
  launch. The host bridge is a different, narrower thing and says so.
- Browser, connected-browser, coding (VM) and command bundles never carry
  across runs (full-actuation §7). Only the local-apps pair does, by lease.
- Candidates stay opaque: no executor id, label or server list travels to the
  launcher. The person who holds a lease sees the executor's name on their own
  lease; nobody else does.
- An agent never binds an executor on its own. A person launches once; the
  lease only extends that person's own launch to that person's own messages.
- Permission prompts from a coding agent are never answered by the driving
  model. In this plan they are denied with a readable reason unless the owner's
  reviewed policy allows the tool up front; relaying them to the person is a
  follow-up ([coding-sessions.md](coding-sessions.md) → "Permission prompts").
