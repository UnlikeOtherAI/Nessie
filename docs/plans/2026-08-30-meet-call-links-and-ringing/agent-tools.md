# Call links + ringing — the agent tools

This chapter continues the numbered design in [the overview](./overview.md).

## 10. The agent tools

**Two builtin ids, not one** — minting a link and ringing a channel are
different blast radii, and tool policy can only distinguish what has its
own id: **`meeting_link_create`** (mint + return a URL) and
**`call_start`** (mint + create the call + ring every member's devices).
Defined beside the other comms tools
(`packages/runtime/src/builtin-comms-tools.ts` array → spread into
`BUILTIN_TOOL_DEFINITIONS`), dispatched in `worker/src/run/tools.ts`,
handlers in `worker/src/run/pa-tools/`:

- **Both `personalAssistantOnly: true`.** They act with the user's own
  rights in the strongest sense — minting under their **Google/Microsoft
  identity** — and the codebase's stated rule
  (`builtin-channel-tools.ts:3`) is that such tools are PA-only. The
  requirement "an agent can generate a call link" is satisfied: the PA is
  that agent. Widening to shared agents later would be
  `requiresExplicitGrant` (§12.5), not a default.
- **`call_start` and prompt injection (decided, §12.5):** PA-only is a
  *kind* gate, not a user confirmation — an ordinary builtin is enabled
  unless denied, so a prompt-injected PA could ring a whole channel's
  devices. The owner decided both tools remain default-on for the PA (like
  `send_message`) so “if I ask it, it just works”; the split ids preserve
  the ability to put only `call_start` behind `requiresExplicitGrant`
  later without touching link minting.
- **Handler:** `resolveActingMember(context)` (live-membership re-read,
  attribution rewritten to the person), then the same shared seam the
  routes use — `createCallLinkForTeamUser` for `meeting_link_create`,
  `startCallForUser` for `call_start`. Link minting takes a `teamId` and
  defaults to that team's provider; ringing defaults to the target
  channel's team provider. Both take an optional `provider` argument so a
  person can ask for a Meet or Teams link even on a Jitsi-preferring team:
  the override is the user's request relayed by their agent, minted under
  that user's own connection, so it grants nothing they could not do
  themselves. Whether to offer it unprompted is the model's judgement,
  never a string-matched heuristic. Typed refusals in words: an unattended
  run with no requesting user; `GOOGLE_NOT_CONNECTED` /
  `MEET_SCOPE_MISSING` / `MICROSOFT_NOT_CONNECTED` name
  `/settings/connections` as the fix.
- **Tenancy keys on the *target* channel, not the run's home channel.**
  `resolveActingMember` reads the run channel's organization; when
  `call_start` names another channel, `startCallForUser` resolves the
  target channel's own organization and re-derives live membership
  (`deactivatedAt IS NULL`) **in that org** — on the UOA multi-org model
  a PA run in org A must never ring an org-B channel under org-A
  membership (the `resolveLocalUserIdsByUoaSub` org-scoping lesson). A
  channel the acting user cannot reach answers the same
  channel-not-found refusal as the route, so the tool cannot probe
  channel existence.
- **Modes:** `meeting_link_create` returns `{provider, meetingUri}` for the
  agent's reply, mirroring member-level `POST /api/meetings/links`.
  `call_start` runs the full §5.2 flow, mirroring
  `POST /api/channels/:id/call` exactly (membership of the acting user,
  human-count, PA-DM refusal, one-call-per-channel). The caller of record
  is the user; `Call.createdViaAgentId` lets surfaces show "N (via
  AgentName)".
- `safe: false`; not metered beyond the run's own budget; no
  `requiresExplicitGrant` (PA-only already binds it to the delegating
  user).
