# Existing Codex and Claude sessions

Status: implementation in progress. Native host verification, Kimix review and
release checks are recorded separately; this document does not certify an
installation.

## Outcome and scope

An agent with the machine owner's existing executor authorization can find an
existing Codex or Claude session, inspect its recent context on request and
send an instruction to that exact native conversation. The shared runtime ships
in all five executor distributions: macOS, Windows and Linux CLI, macOS menu
bar and Windows tray.

There is no new Nessie login, pairing, session grant or action permission.
**Existing coding sessions** defaults to on, including upgraded pairings. Each
local connection has one switch, shared by its GUI and CLI. The original
executor authorization and disclosure checks still apply.

The user explicitly chose experimental provider interfaces. Provider startup
requirements remain visible; they are not another Nessie authorization step.

## Provider behavior

### Codex

The executor discovers the installed native executable and starts a metadata
app-server over stdio with `experimentalApi: true`. Inventory uses
`thread/list` with `useStateDbOnly: true`, bounded pages and explicit provider
and title filters. This avoids scanning all rollout history. The native profile
and thread ID produce a stable opaque executor handle.

`thread/read` supplies metadata, or bounded recent message text when explicitly
requested. A fresh metadata app-server does not own the original client.
`notLoaded` therefore means **live state unknown**, never idle.

Input uses `thread/queue/add`, with the executor command ID as
`clientUserMessageId`. Capability discovery probes `thread/queue/list` before
advertising Queue. Nothing calls `thread/resume`, `turn/start`, private Desktop
IPC or a terminal typing API.

**Native queue does not promise a new turn after completion.** The original
Codex client chooses when to consume input. Desktop was observed consuming a
queued message during an active turn; a CLI test consumed it after completion.
The result says `queued_natively`, not consumed or completed. Steer and Interrupt
remain unavailable when the original runtime cannot be reached with an exact
turn precondition.

### Claude Code

`claude agents --json` supplies active native IDs, process incarnation, working
folder and busy/idle observations. On explicit `detail: events`, the adapter
reads at most 128 KiB from the native transcript tail and returns at most four
user/assistant text messages, each capped at 4,000 characters. Tool payloads and
reasoning are omitted. This transcript reader is experimental too.

A Claude session can accept **Push** when its native MCP channel is connected.
The executor provides the stdio entry point:

```text
nessie-executor serve-existing-claude-channel --state-dir <absolute-pairing-directory>
```

Configure this as the `nessie` MCP server in Claude. Claude's current preview
requires its own `--dangerously-load-development-channels server:nessie`
startup flag. This cannot retrofit a channel into a session whose client does
not support enabling it while running. Such a session remains discoverable and
inspectable and reports why Push is unavailable. Desktop discovery does not
establish Desktop channel support.

The channel binds its parent process to Claude's native agent registry. Its
session ID and process start time must match; a model cannot choose either.
Events pass through the existing pairing's owner-protected state directory.
There is no listener on the network and no additional credential exchange.
Only the `claude/channel` capability is offered, without permission relay.

A channel event may be consumed at a tool boundary during the current turn.
Writing it is not a provider acknowledgement of consumption. The person
answers native permission prompts in the original client.

## Shared bridge and lifecycle

`executor/src/coding-session/bridge.ts` combines two independently owned
lifecycles. `managed-bridge.ts` retains launched-session behavior.
`executor/src/existing-session/` owns native discovery and communication.
External sessions never receive managed `meta.json` records and never enter
managed host spawn, close, process-tree kill or restart paths.

The reserved `EXISTING_CODING_SESSION_OWNER_KEY` identifies sessions belonging
to the paired OS account instead of a Nessie agent/run. It is not a new identity
record. Existing host-session storage and encrypted, short-lived view frames
are reused. External sessions are excluded from generic machine-management
reports and from sharing, including legacy share rows. Pairing-owner session
routes supply the human-facing projection.

A daemon restart upgrades old pairings to include the built-in bridge, even
when no managed agent or root is configured. Existing reviewed managed
configuration is preserved. An externally edited config is not silently blessed.

The local setting is `<pairing-directory>/existing-coding-sessions.json`.
Missing means on; an unreadable or malformed setting fails closed. Discovery
and dispatch reread it, so the CLI disable takes effect without restarting the
daemon. Disable detaches only the executor's own metadata helper and does not
terminate native sessions. Input already handed to a provider cannot be
promised recalled.

Claude dispatch also requires a fresh local receipt of the existing executor
heartbeat. Revocation or shutdown clears that receipt, and a lost daemon's
receipt expires. This is enforcement of existing authority, with no user-facing
approval or new grant.

## Tools and doorways

The home is the existing **Agents → Executors → Sessions** surface. The agent's
result links open the same session detail. The detail identifies externally
owned sessions and describes the native capabilities. It has no Share or Close
action for them. Instructions are sent through the agent already authorized to
use that executor.

| Agent tool | Behavior |
| --- | --- |
| `coding_session_list` | Managed and native inventory. Optional `provider`, title `search` and native pagination `cursor`. |
| `coding_session_wait` | `wait: false` reads an immediate overview. `detail: events` explicitly includes bounded recent text. |
| `coding_session_queue` | Codex native queued input, with client-dependent consumption timing. |
| `coding_session_push` | Claude native channel event when the exact session has a connected channel. |
| `coding_session_steer` | Refused unless a provider adapter offers exact-turn steering; currently unavailable. |
| `coding_session_interrupt` | Existing managed behavior; external targets are refused without a supported exact-turn transport. |

Managed start/send/review/close and terminal-write operations refuse external
handles. Ordinary input never falls back to another action or starts a second
copy of the conversation.

The shared Mac/Windows console places **Existing coding sessions** under the
selected connection's command permissions. All three CLIs expose:

```text
nessie-executor permissions --executor <id> --existing-sessions off
nessie-executor permissions --executor <id> --existing-sessions on
```

`permissions` and `describe` show the effective setting without exposing machine
credentials. Native GUI bridges forward the shared configuration input.

## Delivery and privacy

Every action carries the existing trusted owner stamp and executor command ID.
Visible provider input is labelled Nessie. An owner-private delivery record is
claimed before provider I/O. Reusing an ID with different input is rejected;
a lost connection after dispatch stays `outcome_unknown` and is not retried
blindly. Same-process dispatch is ordered. Provider-native queue ordering still
belongs to the provider.

Claude local events expire after one minute and have a maximum of 32 pending
entries per session. The channel claims an event before writing it, so a crash
cannot replay an uncertain write. A process incarnation mismatch cancels it.

All agent-facing reads travel through the existing executor command and
`ConsumedSourceSink` path. Titles and overview data are owner-private. Full
transcripts are not uploaded by discovery. UOA remains the human identity and
membership authority.

## Verification and limitations

See [provider findings](provider-findings.md) for native versions and observed
queue/channel behavior, and [Kimix review](kimix-review.md) for review findings.
The five executor distributions and provider-client compatibility are separate
matrices: shared runtime tests or a CLI delivery do not prove a Desktop client
supports channels.

Required before delivery: focused protocol and replay tests, existing managed
session regressions, database privacy/sharing tests, rendered session and local
console flows, native Windows/Linux/macOS tests, Kimix review, green required
checks and the single merged feature PR. Actual installation and release status
must be reported separately from source and test status.

### Delivery journal and output bounds

The owner-private journal retains at most 4,096 command receipts per pairing.
At capacity it refuses new input rather than evicting command IDs and allowing
an old command to be sent twice. The session overview and status expose the
latest delivery receipt. Claude receipts distinguish a local acceptance from
an actual channel write; a missing receipt expires to `outcome_unknown` and is
never replayed. Temporary inbox files are removed when their receipt is read.
Native text uses the existing credential and host-path projection before it
leaves the executor. Explicit Claude detail reads take at most 128 KiB from the
native transcript and return at most four text messages.
