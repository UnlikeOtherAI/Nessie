# Channel decision policy

Channel settings owns the policy; the channel header opens that surface. The
Personal Assistant reads it through `channel_list` with `channelId` and edits
the same policy through `channel_update`. Both writes call
`@nessie/team-admin` `updateChannel`, as does `PATCH /api/channels/:channelId`.

`Channel.decisionPolicy` is nullable JSON validated by
`ChannelDecisionPolicySchema`. Null means no configured policy. The starter
policy is disabled, uses a minimum probability of 0.8, and offers four
acknowledgment reactions. A policy contains channel instructions, reaction
descriptions, and up to eight custom questions. Each question has two to
sixteen named options; at least one option must do nothing. A chosen option
can carry instructions for an existing channel agent to perform the work.
The classifier's fixed engagement, reply-depth, and placement questions are
separate from these custom questions.

When enabled, a human message is evaluated once through Ledger's
`POST /v1/vercel/evaluate` with model `typesafe-ai/jev`. That is Ledger's
unified `vercel` connector, so the installation's token grant must name its
`evaluate` endpoint and the model; the separate `vercel-evaluate` service this
once called was never enabled, and Ledger has removed it. The worker
reuses the installation's Ledger URL, credential, signed identity and usage
sink. Installations using a direct provider endpoint must configure Ledger
before enabling the policy. The classifier remains separate from the agent's
generative model and the utility model used by other subsystems.

Jev also judges every human turn in a one-on-one room — one person and one
agent — with no policy at all: whether the agent writes a reply, does the work
and marks the message done, or only reacts, and whether the message goes back
to an earlier one and how the answer points there. That use has its own fixed
questions, threshold and snapshot fingerprint, and falls back silently to a
written answer in the main chat; it is specified in
[reply-threads.md](reply-threads.md) → "One-on-one rooms".

The engagement enum is `reply`, `acknowledge`, `leave_to_human`, or
`no_action`. Separate choices select the agent, an optional configured emoji,
qualitative reply depth (`brief`, `normal`, `detailed`), and thread/channel
placement. Custom questions are independent: a message can receive a reaction
and also start documentation work. Custom work for the same agent is combined
into one background run, separate from any conversational reply. The reply
uses the posting person's authority; the configured task uses policy authority
and remains subject to automation budgets. A background-only run that has
nothing to report ends quietly: it is told to answer with just ✅
(`POLICY_WORK_QUIET_MARK`), and a run acting under the policy's authority
(`actionContext.purpose === 'channel.policy'`) whose answer has no letter or
digit in it posts nothing (`concludesQuietly`,
`worker/src/run/execute/channel-policy-admission.ts`). A result someone needs,
a failure or a required action is written in words and posted as usual. It is
a mark rather than silence because an empty answer is what a failed provider
looks like — the agent loop asks again — and rather than a tool because the
old `conclude_silently` tool made providers return empty completions and was
removed ([rolling-watch-status.md](rolling-watch-status.md)).
Instructions never grant a tool or bypass its existing approval rules.

Each choice must meet the policy's minimum selected-option probability.
Below it, automatic effects are skipped; explicit structured mentions and
structurally addressed conversations remain answerable. Model errors do not
fall back to a generative classifier. A notice explains missing evaluation
access, exhausted credits, or oversized inputs. Agent-authored messages never
trigger another policy evaluation. Disabled or absent policies keep the room's
default engagement ("Rooms without a policy", below), and system DMs keep their structural addressing (a
one-on-one room's reply shape and place are Jev's, as above).
The saved snapshot retains each selected option, probability and threshold
result, distinguishing deliberate no-action choices from uncertain abstentions
without adding notices to chat. Reply routing also abstains when the agent
choice is uncertain; an explicit mention remains the way to choose its recipient.

Agent descriptions and the last five context turns use bounded excerpts.
The latest message and saved policy instructions are not silently shortened.
Serialized UTF-8 requests are capped at 24 KB per state/question and 48 KB
total, conservatively below Jev's token limits; a Choice has at most 255
options. Unknown choices and malformed probability distributions are refused.
The normal signed Ledger attribution and both input/output usage counters
are recorded; free output pricing does not mean output usage is discarded.

The complete serialized policy is limited to 16,000 UTF-8 bytes, including
all guidance, options, reactions and follow-up instructions. The shared
schema enforces this when saved through either the UI, REST or assistant
tool, leaving room for message and conversation context in the classifier
request. Oversized policies ask the editor to shorten guidance or options;
the bound counts bytes, so it also covers multilingual text accurately.

`canModifyChannel` owns edit authority: channel members and organisation
administrators, with its existing direct-message and system-surface rules.
Decision policies are accepted only on standard, non-system channels. A
policy does not create agent bindings or grant tools. Every follow-up must
match an existing `(agentId, channelId, principalUserId)` binding in the same
organisation. A person's Personal Assistant presence must name that exact
person, and a writer may configure only their own presence. Execution must
revalidate live bindings and the requesting person's authority; a saved
policy cannot resurrect a removed presence or widen another person's access.

The shared channel update transaction owns both the mutation and its
`channel.updated` audit entry. Audit metadata contains changed field names,
never the policy's natural-language content. Null clears the saved policy.
Response producers validate stored JSON before exposing the typed
`ChannelRecord.decisionPolicy` field. The assistant's channel-specific read
also lists current agent/principal references so it never invents targets;
the read records the channel disclosure scope.

The assistant's policy write requires a disclosure sink and checks the target
channel through the same `resolveToolPostBasis` used by message tools. A policy
has no per-reader basis rows, so any source restriction not already implied by
the entire channel prevents the write, including accompanying metadata edits.
Clearing a policy writes no source content and remains available.

`Message.channelDecision` stores the validated classifier outcome once;
queue redelivery reuses it instead of choosing new actions under a changed
policy. `Run.promptOverride` pins the selected work instructions for run
restart. `RunThreadPendingMessage.promptOverride` preserves them when the
target agent is already running and the message must wait.

Configured work has a distinct hidden system kickoff, keyed by the original
message, agent and optional PA principal. Its snapshot includes only that
target's policy work and carries the original message's disclosure provenance.
Its canonical message basis and private-source rows are written in that same
transaction, so every reader retains the provenance independently of the snapshot.
The source's current restrictions are unioned with the classification snapshot:
replay cannot freeze an earlier, less restrictive disclosure boundary.
Internal system kickoffs are excluded from the classifier's context window.
The kickoff is not published as a chat message; an eventual reply is anchored
to the original conversation. This keeps a poster's unrelated request from
borrowing the policy author's authority and keeps retries from starting the
same background work twice.
Pending rows also preserve `replyPlacement` and drain individually whenever
they carry policy instructions, preventing unrelated turns from replacing
the selected work or changing its reply location. Normal pending turns retain
their existing batching behavior. Automatic continuations and explicit
restarts preserve the pinned instructions.

The execution-time trigger read always admits its original non-public channel
and raw human author, independently of the recent-message window. A queued
trigger cannot lose its author's disclosure boundary just because later
conversation pushes it outside that window; delegated and legacy triggers keep
their explicit or unknown source authors rather than borrowing a later speaker.
The classifier snapshot also carries its input basis and private source authors,
which are admitted even when those older turns are no longer in the transcript.
Malformed snapshot lineage stops execution. At run start, the refreshed policy
authorizer must satisfy every saved input scope before any provider receives it.

Custom work runs as the person who last saved the policy, never as the person
whose later message triggered it. `Channel.decisionPolicyAuthorizer` captures
that authenticated human's stable user/UOA references and original tenant;
it contains no session, approval, or verification proofs and is server-only.
The classifier snapshot pins that context for replay. Saving a replacement
reauthorizes it; clearing the policy clears its authorizer too.

`resolveChannelPolicyAuthorizer` revalidates at dispatch and run start,
including pending-message drains and run restarts. It asks UOA for fresh
entitlements using the captured subject and credential epoch, verifies the
original team still matches its UOA mapping, and checks current channel
management rights and the exact target binding. Local mode rechecks active
organisation membership. It never substitutes a stored account's newer
identity for a stale captured one. A deactivation, lost channel access,
removed agent, or unmatched PA principal refuses work; UOA unavailability
also refuses. A policy without an authorizer must be saved again.
An organisation administrator's management standing does not grant access to
a protected conversation: target execution also requires that authorizer to
be an actual member of a non-public channel.

Restart and Continue keep their existing caller access gate, then select the
original work by exact agent, PA principal and persisted prompt from the
trigger's `ChannelDecisionSnapshotSchema`. An ordinary reply retains the
caller's authority even when the same trigger also selected custom work.
Policy work revalidates the snapshot's authorizer and source access, retains
the pinned instructions, and runs with `interactive: false`; Continue also
checks the authorizer can still read the checkpoint's run basis. Current
channel configuration never replaces replay authority. Revoked authority,
removed bindings, ambiguous decisions and altered instructions return a
specific HTTP 403 before a new run or checkpoint claim is written.

## Rooms without a policy

A shared room with no enabled policy — a standard channel, or a DM with more
than one person in it — still asks who should answer each human message.
Structural answers come first and are never classified: a composer @mention,
an `@Name` in the text, an @mention of people only (no agent answers), a
system DM's own agent, and a conversation thread's own agent. Past those, an
installation that reaches Ledger asks Jev once
(`judgeChannelEngagement`, `packages/runtime/src/engagement-decisions.ts`):
whether an agent should reply, only react, or stay out; which agent (asked
only when the room has more than one, with agents already in the thread
marked); thread or channel placement; and 👍, 🎉 or ❤️ for a reaction. A
choice counts at 0.8 (`ENGAGEMENT_MINIMUM_PROBABILITY`).

A sure "stay out" is final. A sure reply or reaction by a sure agent is used
as it stands; an unsure placement keeps the reply in its thread and an unsure
reaction is 👍. Everything else — an unsure engagement, an unsure or `none`
agent under a reply, a timeout (4 s), any Ledger error, an input over Jev's
limits — hands the message to the generative orchestrator
(`decideAgentEngagement`, `packages/runtime/src/orchestrator.ts`), which
decides exactly as it did before Jev. Exhausted credits are the exception:
they are surfaced, because the generative model would refuse too. Nothing is
pinned on the message, as before: a redelivered job asks again.

The reason is cost and latency, not a different judgement: the generative
orchestrator spends a reasoning-model call on every human message in every
shared room, most of them people talking to each other, while Jev answers in
a few hundred milliseconds for about $0.00003.
