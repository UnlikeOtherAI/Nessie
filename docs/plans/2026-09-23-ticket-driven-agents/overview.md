# Ticket-driven agents: start work by moving a ticket

Status: plan, 2026-09-23. It builds on
[executor local apps](../2026-09-22-executor-local-apps/overview.md) (coding
sessions, conversation leases, screenshots). A first draft went through four
adversarial reviews: security, follow-through with a weak model, codebase fit,
and UI setup. Every rule below answers a finding from one of them. Nothing in
this plan is a built-in agent.

## The goal

A team runs a project board. People create tickets. When a person moves a
ticket into a start-work column, an agent the team set up picks it up. Here
that agent is a CTO, but nothing in code knows that word. The agent reads the
ticket and has the work done on one of its owner's paired machines, by
instructing a local Claude Code or Codex session. It never writes the code
itself. Work stops at a merged pull request, and the ticket moves to Done.

While the work runs:

- New information on the ticket reaches the coding agent. That covers a
  comment, an edited description, a changed priority, or a message in the
  ticket's work thread.
- An edit to one of the project's tech documents wakes the agent. It reviews
  the edit and passes it on when the edit belongs to a ticket in progress.
- The agent can set itself a one-off reminder ("check back in 15 minutes")
  when it waits on something that will not wake it.
- Two machines work two tickets at once. A third ticket waits its turn.
- Everyone on the project can see, on the ticket and the board card, what the
  agent is doing and why it woke.

All of it is set up through the product. A person can talk to the Agent
Designer, or click through the Triggers editor, the board and the machine
page. The agent itself can later set up new projects and flows for the person
it is talking to.

## Decisions Ondrej made (2026-09-23)

1. **Who starts work: any project member who can edit the board.** Moving a
   ticket into a start-work column starts work under the machine access the
   machines' owner confirmed. Only a move a *person* makes counts. See
   [triggers.md](triggers.md#who-starts-work).
2. **Done means merged.** The coding agent opens the pull request and merges
   it when CI is green. The agent checks the pull request's state, moves the
   ticket to Done and comments the link.
3. **A busy pool queues.** Each machine works one ticket at a time. Extra
   tickets wait in priority order and start when a machine frees up or comes
   online.
4. **Everyone on the project sees progress.** Ticket comments may carry the
   coding agent's summaries and the pull request link.

## Table of Contents

| Chapter | Settles |
|---|---|
| [triggers.md](triggers.md) | Ticket event provenance, the `ticket_changed` and `document_changed` trigger types, their typed configuration and dispatch, and what happens to board watchers |
| [ticket-work.md](ticket-work.md) | The work record and its thread, the `ticket.work` run purpose and its authority, what every wake tells the agent, platform-owned teardown, reminders, session wakes, the pool queue, limits, and what the project sees |
| [machine-access.md](machine-access.md) | Standing machine access: the policy, its host profile and pinned digests, the one confirmation card, binding at each wake, session isolation, server-side closes, fences, audit, and the invariant amendments |
| [setup-and-ui.md](setup-and-ui.md) | Everything a person or the Designer needs to set this up, the UI doorways (Rule zero), and the project-operator capability that lets an agent set up new projects and flows |
| [verification.md](verification.md) | The PR order, tests and browser suites per PR, and the live acceptance run done through the UI |

## PR order

| PR | Needs | Ships |
|---|---|---|
| 3b (open) | — | Coding-session control, already in review |
| **T0 contracts** | — | Enum values, the `ticket.work` purpose, every new table with its CHECKs, queue payload schemas, the TaskEvent provenance shape, the standard `docs/standards/ticket-work.md`, and one `agent-triggers` browser fixture scaffold. It touches nothing 3b changes, so it does not wait for 3b |
| **T1 ticket triggers** | T0 | Ticket events and provenance, `ticket_changed`, the work record and thread, `ticket.work` runs acting as the agent, follow wakes, platform teardown, the ticket chip and card badge, wake rows, the Triggers editor, Designer support, and watcher clean-up. There are no machines yet: the agent triages, comments and moves tickets |
| **T2 document trigger** | T1 | `document_changed`, the version hook, the shared line diff, `kb_page_diff`, routing a ticket's documents to its thread, and the Finder doorway |
| **T3 reminders** | T1 | `check_back_in`, the quiet-wake safety net and the `ticket-work.sweep` job |
| **T4 machine access** | T1, 3b | The coding-session owner *context* and the new close reasons, then the standing policy, host profile, digests, the composite card, pool assignment at dispatch, binding, isolation, closes, fences, audit, ticket-mode coding tools, pull-request tracking, limits and cost, the executor page and trigger Machine access section, and the invariant amendments |
| **T5 session wakes and dequeue** | T4 | The heartbeat intake wake over the session report's turn numbers (which T4 already ships), dequeue across policies, the waiting-machine and back-online states |
| **T6 project operator** | T1 | The explicit-grant project-operator capability, workflow tools moved behind it, and the CTO setting up new projects and flows for its live requester |

T2, T3, T4 and T6 run in parallel after T1 and merge in that order, each green
on its own. The live acceptance run starts when T5 is on `main`.

## Invariants this plan amends

Each amendment ships in the PR named, in the file named. The text is in
[machine-access.md](machine-access.md#amendments).

| Rule | File | PR |
|---|---|---|
| Only a person binds an executor to a run: gains the standing-policy clause | `docs/executor-protocol/overview.md` "Binding" | T4 |
| "Nothing a system, workflow or agent posts" carries a lease | `docs/executor-protocol/conversation-leases.md` | T4 (states that the standing policy is a separate path, not a lease) |
| Host output is the launch conversation's, and a person's consent | `docs/standards/disclosure-boundaries.md` | T4 |
| The coding-session owner is the launch or lease actor | `docs/executor-protocol/host-coding-sessions.md`, the local-apps coding-sessions chapter | T4 |
| Unattended runs never reconstruct a requester; the two-lock rule | `docs/standards/global-agents.md` | T1 (agent ticket actor), T4 |
| A schedule is not a person asking | `worker/src/run/send-authorization.ts` comment and its standard | T3 |
| Ticket events and actor provenance | `docs/standards/ticket-activity.md` | T1 |
| Board watchers wake agents | `docs/plans/2026-09-06-board-watchers.md` | T1 |
| Per-run budgets | `docs/standards/tech-and-run-budgets.md` | T4 |

## What still needs a person

The platform cannot and must not do these:

- Pair each machine as a **private** executor, as the person who will own the
  machine access, and review its coding-sessions configuration.
- Allow `git push`, `gh pr create`, `gh pr checks` and `gh pr merge` in that
  configuration, and have `gh` and Claude Code logged in on the machine with
  the repository under a configured root. The card warns when they are not
  allowed.
- Set `maxBudgetUsd` for Claude Code in that coding-sessions configuration,
  at or below the ticket's spend limit, and run an executor new enough to
  sign it: a machine without a signed per-turn budget cannot take ticket work,
  and the Designer says "ticket work: not yet" for it.
- Press the one machine-access confirmation card with fresh verification.
- Answer the coding agent's product questions, through ticket comments.
- Widen a machine's permissions after a denial. Restart a ticket that hit a
  limit, by moving it out of and back into a start-work column. Bring an
  offline machine back online.
- Approve a pull request when branch protection requires a human reviewer.
