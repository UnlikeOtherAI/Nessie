# Provider findings: existing coding sessions

Date: 2026-09-26. [Implementation plan](overview.md).

## Verdict

Existing-session discovery is feasible. Exact live control, especially desktop
control, remains unverified. Do not infer it from saved-history access or CLI
resume. This is a preliminary experimental report, not completion of the
brief's full pre-build acceptance suite.

Probes were read-only: versions/help, generated Codex protocol bindings,
provider-native inventory, initialized metadata-only app-server requests and
limited process/socket metadata. No prompt was sent to an existing session;
no session was interrupted, restarted or resumed. Temporary app-server
processes were closed after the reads. No production code changed.

## Actual machines and versions

| Host | Codex on CLI PATH | Desktop-bundled Codex | Claude Code on CLI PATH | Native live inventory |
| --- | --- | --- | --- | --- |
| macOS arm64, dictator | 0.154.0 | 0.158.0-alpha.2.1 | 2.1.283 | Claude returned 8 sessions; process executable paths identified all 8 as desktop-hosted. Busy and idle observed across reads. |
| Windows x64, Minis | 0.141.0 | 0.158.0-alpha.2.1 | 2.1.283 | Claude returned 10 sessions, busy and idle; all 10 mapped to the Desktop-bundled Claude Code 2.1.281 executable. |
| Ubuntu x64, umac | 0.156.1 | Not inventoried | 2.1.281 | Claude returned an empty array. No positive live-session proof on Linux. |

Windows SSH worked through `Minis.local`. `umac.local` did not resolve from
this Mac; the supplied LAN IPv4 fallback worked. Linux's non-login SSH PATH
omitted the installed CLIs; its login shell found them. The Nessie checkout
there is `/home/umac/Projects/Nessie`, with a capital N. These are probe setup
details, not instructions to hardcode machine names into the product.

## Codex observations

1. Mac CLI and desktop-bundled CLI, Linux CLI and Windows PATH CLI each accepted
   `initialize`, `thread/list`, `thread/loaded/list`, and a metadata-only
   `thread/read` through a fresh `app-server --stdio` process.
2. Each returned a five-record persisted sample and a continuation cursor.
   Each returned **zero loaded threads**, and each sampled thread was
   `notLoaded` relative to that new server. Mac/Windows samples used source
   `vscode`; Linux used `cli`. Source alone does not establish visible client
   identity. Metadata reads preserved the selected native ID and included
   zero turns. No transcript was requested or retained.
3. Mac and Linux default app-server control socket probes failed with “No such
   file or directory”. A live Mac desktop Codex process was observed running
   `app-server` without an explicit listener; no default control socket was
   available. Windows desktop app-server processes had either no explicit
   listener or `stdio://`. This does not prove no integration exists; it does
   disprove treating the default socket as available on these installations.
4. Windows PATH CLI 0.141.0 answered that daemon lifecycle is Unix-only. The
   desktop-bundled 0.158.0-alpha.2.1 instead attempted a socket connection and
   failed with OS error 10050. The latter exposes `queue --help`; the PATH
   version's help did not expose that command. A blanket claim that current
   Windows Codex cannot use daemon transport would overstate these results.
5. Mac 0.154.0 exposes `codex queue --thread <id> --message <text>` and
   `app-server proxy --sock <path>`. Generating the desktop binary's bindings
   with `--experimental` exposes `thread/queue/add`, `list`, `update`, `delete`,
   `reorder`, `start` and `thread/queue/changed`. Queue add requires a
   `clientUserMessageId`. Steer requires `expectedTurnId`; interrupt names
   `threadId` and `turnId`. These are schema observations, not live tests.
6. The installed `TurnStartParams` explicitly mentions steering an already
   active turn. Therefore checking idle and later calling start is not a safe
   implementation of a queue-only grant.

Current OpenAI documentation describes thread metadata reads, loaded-thread
listing and lifecycle notifications after start/resume. It marks app-server
and WebSocket transport experimental and unsupported for production workloads.
A metadata read does not attach to a live runtime. Any adapter release must
state its experimental compatibility and verify its pinned provider versions.
[OpenAI app-server documentation](https://developers.openai.com/codex/app-server/).

Official source inspected at `a6bd19261c30ce0a0225fe90e646822d29916f11`:

- [CLI queue implementation](https://github.com/openai/codex/blob/a6bd19261c30ce0a0225fe90e646822d29916f11/codex-rs/tui/src/session_queue_commands.rs)
  explicitly protects against queuing through a separate embedded server when
  the shared daemon is present. This strengthens the owning-runtime requirement.
- [Queue request processor](https://github.com/openai/codex/blob/a6bd19261c30ce0a0225fe90e646822d29916f11/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)
  can enqueue against persisted identity but requires a loaded thread to start
  queued work. Queue acceptance alone does not prove the visible session
  received or consumed the input. Upstream main is not assumed identical to
  any installed binary; generated bindings are recorded separately above.

### Capability status

| Requirement | Status from these probes |
| --- | --- |
| Discover persisted sessions / native IDs | PASS on the four tested binaries across three OSes |
| Discover active sessions in the owning runtime | BLOCKED on the tested default socket routes; other supported routes not yet established |
| Inspect real active/idle state | NOT TESTED; fresh-server `notLoaded` is insufficient |
| Queue next normal input / idle input to the exact existing conversation | NOT TESTED |
| Steer / interrupt / lifecycle event subscription | Schema/documentation available; NOT TESTED against existing live sessions |
| Codex Desktop exact-conversation control | NOT TESTED; release blocker |
| IDE exact-conversation control / native-ID continuity across restart | NOT TESTED |

Recommended adapter: connect to a proven owning runtime, use its native queue,
steer and interrupt methods, and retain per-operation version gates. Persisted
inventory can be a separate read source, labelled with unknown live state.

## Claude Code observations

`claude agents --json` is a native discovery interface, not process-title
scraping. In the tested versions it returned `pid`, `cwd`, `kind`, `startedAt`,
`sessionId`, `name` and `status`. Matching returned PIDs to executable paths
established that the positive Mac/Windows samples were desktop-hosted. This
does not establish how a particular row appears in the desktop UI or grant an
external control channel. The command is also documented in the
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

Channels require per-session enablement; standard MCP registration alone is
insufficient. Custom channels during the preview require an applicable
allowlist or an explicit development flag. Organization policy still applies.
The current docs also warn that a channel negotiating MCP revision 2026-07-28
under automatic v2 negotiation may not register. Do not infer availability
from a successful MCP connection or from flags appearing in help.
[Claude Channels](https://code.claude.com/docs/en/channels).

The native channel is a Claude-spawned stdio MCP server using the
`claude/channel` capability and `notifications/claude/channel`. Busy-session
events are batched for a subsequent turn. Transport writes are not acknowledged
as processing, and events can be silently dropped when channel registration or
policy is absent. An optional reply tool can supply application confirmation.
This supports a distinct event-push operation, not an assumed identical normal
user-turn queue or current-turn steer.
[Channels reference](https://code.claude.com/docs/en/channels-reference).

Current desktop documentation offers Linux beta as well as macOS and Windows.
Do not rely on older statements that desktop is unavailable on Linux. Desktop
setup and CLI flags remain separate compatibility cases.
[Claude Desktop](https://code.claude.com/docs/en/desktop).

### Capability status

| Requirement | Status from these probes |
| --- | --- |
| Discover live sessions and distinct native IDs | PASS on Mac/Windows, including desktop-hosted runtimes; empty-query-only on Linux |
| Inspect busy/idle metadata | PASS on Mac/Windows; richer turn/permission overview NOT TESTED |
| Persisted inactive inventory / ID continuity across restart | NOT TESTED |
| Push into an enrolled existing session | Documented; NOT TESTED |
| Enable push in a session already open without enrolment | NOT ESTABLISHED; release blocker for transparent attachment |
| Exact idle injection / normal user-turn queue | NOT TESTED; channel events are a distinct input type |
| Current-turn steer / interrupt | NOT ESTABLISHED for arbitrary existing sessions; channel contract alone is insufficient |
| Native lifecycle events / 50 repeated messages / delivery acknowledgement | NOT TESTED |
| Desktop GUI control and visible history | NOT TESTED on all platforms |

Recommended adapter: native inventory plus explicit, identity-bound channel
enrolment where proven. Keep discovered unregistered sessions inspect-only
after local consent. Do not spawn `claude --resume` as an attachment workaround;
the current CLI even documents that resuming a running session in background
may create a copy, which would violate the acceptance criterion.

## Reproduction and remaining experiment

For metadata probes, start a temporary `codex app-server --stdio`, perform the
`initialize`/`initialized` handshake, then send:

```json
{"id":2,"method":"thread/list","params":{"limit":5,"useStateDbOnly":true,"modelProviders":[]}}
{"id":3,"method":"thread/loaded/list","params":{"limit":100}}
{"id":4,"method":"thread/read","params":{"threadId":"<id from response 2>","includeTurns":false}}
```

Close only this temporary process after the responses. Do not call
`thread/resume`, `turn/start` or any mutation during inventory. Do not copy
provider credentials, full outputs, private session titles or transcripts into
the repository. Generate schemas with the actual target binary using
`app-server generate-ts --experimental --out <scratch-directory>`.

Phase 0 in the plan owns the remaining real-delivery experiments, native
desktop visibility, consent/enrolment proof and operation-by-operation matrix.
The research does not substitute for those tests.
