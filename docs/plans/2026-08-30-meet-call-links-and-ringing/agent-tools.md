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
- **`call_start` and prompt injection (decision flagged, §12.5):** PA-only
  is a *kind* gate, not a user confirmation — an ordinary builtin is
  enabled unless denied, so a prompt-injected PA could ring a whole
  channel's devices. The mitigation options are `requiresExplicitGrant`
  on `call_start` (one-time owner grant per agent — friction the owner
  explicitly doesn't want for "if I ask it") or leaving it default-on for
  the PA like `send_message` (which an injected PA can equally abuse,
  with smaller blast radius). Recommendation: default-on for the PA in
  v1 — the engagement path already means a person asked the PA
  something — with the split ids preserving the ability to flip
  `call_start` to explicit-grant without touching link minting. Owner
  decides.
- **Handler:** `resolveActingMember(context)` (live-membership re-read,
  attribution rewritten to the person), then the same shared seam the
  routes use — `createCallLinkForTeamUser` for link-only,
  `startCallForUser` when ringing. The provider **defaults to the
  conversation channel's team setting** (§3.0), and the tool takes an
  optional `provider` argument so a person can ask the agent for a Meet
  or Teams link even on a Jitsi-preferring team (owner's explicit call,
  2026-08-30): the override is the *user's* request relayed by their
  agent, minted under that user's own connection, so it grants nothing
  the user couldn't do with their own account. Whether to offer the
  override unprompted is the model's judgement, never a string-matched
  heuristic. The mirroring REST route accepts the same optional
  `provider`, keeping tool and route no-weaker-no-stronger. "Remind
  people about the call" needs no new tool — that's the agent posting an
  ordinary message with the link. Typed refusals in words: unattended
  run with no requesting user; `GOOGLE_NOT_CONNECTED` /
  `MEET_SCOPE_MISSING` / `MICROSOFT_NOT_CONNECTED` (the answer names
  `/settings/connections`).
- **Tenancy keys on the *target* channel, not the run's home channel.**
  `resolveActingMember` reads the run channel's organization; when
  `ring: true` names another channel, `startCallForUser` resolves the
  target channel's own organization and re-derives live membership
  (`deactivatedAt IS NULL`) **in that org** — on the UOA multi-org model
  a PA run in org A must never ring an org-B channel under org-A
  membership (the `resolveLocalUserIdsByUoaSub` org-scoping lesson). A
  channel the acting user cannot reach answers the same
  channel-not-found refusal as the route, so the tool cannot probe
  channel existence.
- **Modes:** default returns `{meetingUri}` for the agent's reply
  (mirroring a new member-level `POST /api/meetings/links` route that
  ships in the same change — same service, same gates, per the
  tools-mirror-routes rule and Rule zero). Optional `ring: true` +
  `channelId` runs the full §5.2 flow, mirroring
  `POST /api/channels/:id/call` exactly (membership of the acting user,
  human-count, PA-DM refusal, one-call-per-channel). The caller of record
  is the user; `Call.createdViaAgentId` lets surfaces show "N (via
  AgentName)".
- `safe: false`; not metered beyond the run's own budget; no
  `requiresExplicitGrant` (PA-only already binds it to the delegating
  user).

