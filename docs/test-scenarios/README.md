# Agent Communication — Test Scenarios

End-to-end scenarios exercising the agent pipeline: user auth -> thread
creation -> message post -> orchestrator decision -> run -> worker ->
reply message with reactions.

All scenarios share a fictional organisation **Orbital Foundry** with
four personas:

| Persona    | Role                  | Login (email)                     |
| ---------- | --------------------- | --------------------------------- |
| Alex Rivera| Project Manager       | alex.rivera@orbitalfoundry.test   |
| Sam Chen   | Senior Developer      | sam.chen@orbitalfoundry.test      |
| Morgan Bale| Developer / EA relay  | morgan.bale@orbitalfoundry.test   |
| Jordan Park| Executive (boss)      | jordan.park@orbitalfoundry.test   |

Password for every persona in local: `nessie-test-pw`.

## Agents in play

| Agent            | Role      | Typical channel      |
| ---------------- | --------- | -------------------- |
| Sprint Scribe    | assistant | sprint-planning      |
| Code Buddy       | coder     | dev-chatter          |
| Executive Brief  | assistant | exec-briefings       |
| Calendar Keeper  | assistant | ea-workroom          |

## Ports (non-negotiable)

- API: `http://localhost:5454`
- Admin: `http://localhost:5455`

## Running a scenario

Each scenario file is self-contained and lists the exact `curl` calls,
expected HTTP codes, and the SQL checks used to confirm the worker
delivered a reply. Scenarios were first executed on **2026-04-10** and
are the reference truth for "agents work end-to-end".

## Index

1. [scenario-01-pm-standup.md](scenario-01-pm-standup.md) — PM posts a
   standup prompt; Sprint Scribe replies in sprint-planning.
2. [scenario-02-dev-code-buddy.md](scenario-02-dev-code-buddy.md) — Dev
   asks Code Buddy a technical question in dev-chatter.
3. [scenario-03-boss-ea.md](scenario-03-boss-ea.md) — Boss + Executive
   Assistant drive Executive Brief and Calendar Keeper in parallel
   channels.
4. [scenario-04-orchestrator-routing.md](scenario-04-orchestrator-routing.md)
   — Messages without `@mentions`; LLM orchestrator decides to engage or
   stay silent.
5. [scenario-05-cross-channel-and-multi-mention.md](scenario-05-cross-channel-and-multi-mention.md)
   — `@mention` an agent not bound to the channel, and `@mention` two
   agents in a single message.

## Bugs discovered + fixed during the first run (2026-04-10)

| # | Area                               | Symptom                                                         | Root cause                                                                                               | Fix                                                                                                       |
| - | ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1 | `api/.env` loading                 | Worker ran without `OPENAI_API_KEY`; runs failed                | `tsx watch` didn't pass `--env-file`                                                                     | Added `--env-file=../.env` to api + worker dev scripts.                                                   |
| 2 | `packages/runtime/.../connectors.ts` | Every gpt-5-mini request returned 400 "temperature not supported" | Reasoning-era OpenAI models reject non-default `temperature`; orchestrator hard-codes `0.1`              | `resolveOpenAiTemperature` drops the field for `gpt-5|o1|o3|o4` prefixes.                                 |
| 3 | Persistent auth across restarts    | Every restart invalidated tokens                                | `NESSIE_AUTH_SECRET` defaulted to `randomUUID()` in local mode                                           | Set persistent `NESSIE_AUTH_SECRET` in `.env`.                                                            |
| 4 | `api/src/services/messages.ts`     | Cross-channel `@mention` grabbed too many words                 | Greedy regex `/@([\w][\w\s]*[\w]|[\w]+)/g` captured "Code Buddy what think" as one name                  | Per-agent name match reusing the orchestrator's escape rule — identical parsing on both sides.            |
| 5 | `api/src/services/orchestrator.ts` | Multi-agent `@mention` only triggered the first agent           | Fast-path returned a single `OrchestratorDecision` on first regex hit                                    | Return `OrchestratorDecision[]`, collect all matches, POST handler iterates and enqueues per decision.    |
