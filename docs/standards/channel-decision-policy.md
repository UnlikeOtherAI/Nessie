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
`POST /v1/vercel-evaluate/evaluate` with model `typesafe-ai/jev`. The worker
reuses the installation's Ledger URL, credential, signed identity and usage
sink. Installations using a direct provider endpoint must configure Ledger
before enabling the policy. The classifier remains separate from the agent's
generative model and the utility model used by other subsystems.

The engagement enum is `reply`, `acknowledge`, `leave_to_human`, or
`no_action`. Separate choices select the agent, an optional configured emoji,
qualitative reply depth (`brief`, `normal`, `detailed`), and thread/channel
placement. Custom questions are independent: a message can receive a reaction
and also start documentation work. Custom work for the same agent is combined
into one background run, separate from any conversational reply. The reply
uses the posting person's authority; the configured task uses policy authority
and remains subject to automation budgets. A background-only run
is prompted to conclude silently unless it has a useful result or needs help.
Instructions never grant a tool or bypass its existing approval rules.

Each choice must meet the policy's minimum selected-option probability.
Below it, automatic effects are skipped; explicit structured mentions and
structurally addressed conversations remain answerable. Model errors do not
fall back to a generative classifier. A notice explains missing evaluation
access, exhausted credits, or oversized inputs. Agent-authored messages never
trigger another policy evaluation. Disabled or absent policies retain normal
engagement behavior, and system DMs keep their structural response rules.

Agent descriptions and the last five context turns use bounded excerpts.
The latest message and saved policy instructions are not silently shortened.
Serialized UTF-8 requests are capped at 24 KB per state/question and 48 KB
total, conservatively below Jev's token limits; a Choice has at most 255
options. Unknown choices and malformed probability distributions are refused.
The normal signed Ledger attribution and both input/output usage counters
are recorded; free output pricing does not mean output usage is discarded.

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
