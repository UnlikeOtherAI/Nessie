# Expanded channel plan: Kimix and Astra reviews

On 2026-09-26, Kimix K3 and GPT-6 Astra independently reviewed
[`../plans/2026-09-26-channel-announcements.md`](../plans/2026-09-26-channel-announcements.md)
read-only. Neither edited files or ran tests. Kimix's verdict was **build after
targeted spec revisions**; Astra's verdict was **revise before implementation**.
The plan was revised after both reviews and before implementation resumed.

| Finding | Plan disposition |
| --- | --- |
| UOA roster members may have no local `User`; existing `User` rows also persist UOA profile mirrors. | Freeze subject-keyed product delivery/receipt rows, create no user/profile mirror for notifications, materialise a bell alert and pending reminder when a member first signs in. Explicitly call out the existing profile mirror violation and its API-backed migration. |
| A private read-only room cannot demand confirmation from its whole org/team. | Require public visibility for confirmation-required posts and refuse later protection while an active obligation exists. |
| An acknowledged post could be edited or deleted; an old queued reminder could point at deleted content. | Freeze content/attachments, forbid edits, cancel obligations explicitly on deletion, stop queued jobs and preserve a removed-post destination. |
| A queued sender-authored DM needs a live authority and a concrete UOA identity lifecycle. | Persist explicit audited action, use stable subject and existing scoped encrypted link for fresh `/org/me`, block visibly on revocation/unavailability, and gate the button by current sender standing. |
| Message commit and push enqueue were separate; replay did not repair the gap. | Write announcement and reminder push jobs in their message transactions; test crash and retry boundaries. |
| Org-wide DMs had no team; `findOrCreateDmChannel` requires one. | Use the organisation shared-channel root for standalone posts and exact team for project posts, with an explicit server-owned DM send path. |
| Acknowledgment can race reminder fanout. | Lock the receipt and decide eligibility in the same transaction as the DM and outbox write. |
| Mandatory/confirmation pushes could still be suppressed by `pushMentions`. | Give them an announcement push class that bypasses channel mute, `pushMessages`, and `pushMentions` while respecting global, focus, quiet and OS controls. |
| Reminder repetition and progress were unclear. | One lifetime reminder per message/recipient, retries for failed sends, audited batch, sender-scoped progress updates. |
| Seen status is a new disclosure to admins. | Tell recipients that opening a required post reports seen state; keep detailed status in an authorised panel. |

The user's later clarification superseded the initial “Remind unseen” wording:
manual reminders target **all recipients who have not clicked Acknowledge**,
including people who opened the post. The user also requested the existing
“Also send to #channel” checkbox pattern and an individual DM from the
original sender. “Always-on or leave” currently means leaving the relevant
team or organisation, pending the user's answer to that specific question.
