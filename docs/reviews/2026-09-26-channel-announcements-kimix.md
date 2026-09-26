# Kimix review: channel announcements plan

Kimix K3 reviewed the first draft of
[`../plans/2026-09-26-channel-announcements.md`](../plans/2026-09-26-channel-announcements.md)
read-only on 2026-09-26 in the `channel-announcements` worktree. Verdict:
**revise before building**. The review inspected channel roles, message writes,
alerts, realtime and push. It ran no tests and made no edits.

| Finding | Disposition in the revised plan |
| --- | --- |
| Push could notify a person absent from the frozen durable-alert audience. | Dispatch from the message's alert rows and recheck current access. |
| Agent and system message sinks lacked a policy. | Classify every direct write, refuse incompatible bindings/targets, surface durable automation failures and enforce the final boundary at message insert. |
| Global push, focus and quiet hours were unspecified. | Preserve those user-wide controls; mandatory bypasses channel mute and `pushMessages` only. |
| Announcement marker could not use the strict invitation metadata DTO or a new alert enum in one rolling deploy. | Store the marker on the row and project an additive optional `isAnnouncement` field while retaining the existing `mention` wire kind. |
| Protected-channel transitions, retries, concurrency, old replicas and the UI permission projection needed acceptance tests. | The revised plan names each case and the activation order. |

The review recommended treating local `TeamMember.role` as the UOA role
authority. That recommendation was **not adopted**. `request-admission.ts`
already verifies the organisation's role through a fresh subject-asserted
`/org/me` read on each request (`uoa-request-authorization.ts` and
`uoa-role-capabilities.ts`); the existing paged roster is not this path.
The same `/org/me` response includes `org.team_roles` in the verified UOA
contract (`api/test/uoa-team-directory-parse.test.ts`). The revised plan uses
that exact response for team standing. This preserves the user's UOA authority
rule and next-request demotion behavior without a second durable store or a
paged roster lookup. Local roles remain authoritative only for an install
without an IdP.

The reviewer did not verify every assistant or MCP ingress call chain, so the
implementation audit must prove or guard those paths before delivery.
