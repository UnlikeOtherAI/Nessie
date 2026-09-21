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
