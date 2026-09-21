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

`Message.channelDecision` stores the validated classifier outcome once;
queue redelivery reuses it instead of choosing new actions under a changed
policy. `Run.promptOverride` pins the selected work instructions for run
restart. `RunThreadPendingMessage.promptOverride` preserves them when the
target agent is already running and the message must wait.

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
