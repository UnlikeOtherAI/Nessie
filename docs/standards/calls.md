# Provider-linked calls + ringing

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches calls rather than loaded into every session.
`AGENTS.md` → "Architecture" carries the one-line summary and points here;
**this file is the rule.**

Calls are provider links, never an embedded Jitsi media surface: an owner or
admin selects each target team's Google Meet, Jitsi, or (when configured)
Microsoft Teams provider in `/settings/organization`; the caller popup links
its provider label there for that same audience. A channel call creates that
link then rings each invitee. Realtime publishes one
message per audience — one channel update and separate user-scoped incoming
rings — because combined scopes leak/replay incorrectly. Native push carries
only an internal call path/id, never an external meeting URI; the client loads
the call before opening the provider link. Browser Accept is a real anchor (or
a synchronous user gesture in a shell), never an asynchronous `window.open`.
`meeting_link_create` and `call_start` are PA-only builtins: they re-read the
acting member and call the same `@nessie/team-admin` functions as the
routes; `call_start` resolves membership from its target channel's organisation
and stamps `Call.createdViaAgentId`.

Spec: [docs/plans/2026-08-30-meet-call-links-and-ringing/overview.md](../plans/2026-08-30-meet-call-links-and-ringing/overview.md).
This is the calling of *people into meetings*; calling the Personal Assistant
by voice is a different subsystem —
[docs/standards/voice-calling.md](voice-calling.md).
