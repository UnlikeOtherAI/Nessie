# Agent home suggestions

## Plan

1. Replace the three fixed prompts on the existing agent DM homepage with three
   model-generated questions based on recent conversations in that explicit DM.
2. Persist the result per organisation, person and agent. Detect newly created
   conversations and changed messages; refresh on the next home read after activity,
   at most once every six hours. Never regenerate unchanged history merely because
   time passed or the person opened the homepage. Defer while a run is active.
3. Atomically claim attempts in Postgres, including failed attempts, so replicas,
   reloads and simultaneous tabs cannot spend the budget twice.
4. Keep the existing generic prompts when no usable history or model result exists.
   Keep the existing new-conversation flow and destination.
5. Verify cache cadence, concurrent claims, malformed output, private-source access,
   and desktop/phone rendering and starting a conversation from a suggestion.

## Contract and boundaries

The owning surface is `AgentSessionHome`, reached by tapping an agent in the
sidebar. `GET /api/agents/:agentId/conversation-suggestions?channelId=...` reads
and lazily refreshes the cache. Nothing is generated for an unattended homepage;
conversation activity makes the next read eligible after the cooldown. The open
home checks once per minute, and checks on returning to it. A conversation has no
explicit finish operation: a terminal agent run and its completed message supply
the finished activity. No additional settings or status UI are added.

The requested channel must be a live, unarchived DM containing only this person
and this agent. History is bounded to 30 recent non-system, non-deleted messages
from its agent conversations (including General), at most 12,000 characters.
Messages with additional disclosure scopes are excluded, as for search snippets;
no grant-only content is paraphrased into a new user-authored message. No history
from another DM, shared channel, organisation or person is admitted. This explicit
DM scope matches the suggestion's destination. The prompt treats history as data,
asks for three distinct concrete next questions in the person's language, and
avoids inventing tasks or suggesting already completed work.

Only question text and source ids/hashes are retained, never a transcript copy.
Every read rechecks the DM audience and every retained source's deletion, edits,
conversation membership and disclosure scope. Invalidated sources hide the result
immediately even during cooldown. Generation repeats those checks before returning.
Inference uses the configured shared model and attributes usage to the requester.


## Verification commands

- API regression: `api/test/agent-conversation-suggestions.test.ts`, using `pnpm exec turbo run test:agent-suggestions --filter=@nessie/api`
  with a migrated `DATABASE_URL`.
- Rendered flow: `pnpm --filter @nessie/admin test:e2e:agent-suggestions`, with a
  dedicated migrated `DATABASE_URL` and free `NAV_E2E_API_PORT` /
  `NAV_E2E_ADMIN_PORT`. It uses scripted inference with the real API and worker,
  verifies desktop/tablet/phone, reload caching, the exact sent question, the
  private destination, Back, and an outsider's refusal. Screenshots are saved
  under `e2e/screenshots/agent-suggestions/`.


## Verified behavior

The Postgres regression exercises concurrent claims, no-history behavior, unchanged
history across cooldowns, new conversations, active/terminal runs, completed replies,
edits, deletion during inference, disclosure changes, additional DM members,
organisation isolation, deactivation and malformed model output. The rendered flow
passed at all three viewports with scripted inference; screenshots were inspected.
This verifies the integration and prompt contract, not live-model suggestion quality.
