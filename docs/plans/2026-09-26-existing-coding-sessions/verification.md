# Existing-session verification

Date: 26 September 2026. The implemented scope and provider limits are in
[the guide](overview.md); independent findings and fixes are in
[the Kimix review](kimix-review.md).

## Native providers

All delivery probes used a newly opened, disposable native conversation. The
executor adapter discovered that conversation and sent input to its exact
native ID. The original client answered a unique test token. No resume, fork,
replacement client or original-process kill was used to inject input.

| Host | Codex | Claude Code |
| --- | --- | --- |
| macOS | Native queue consumed in the original CLI conversation; a separate Desktop queue experiment is recorded in provider findings. | Native channel Push consumed in the original CLI conversation on 2.1.283. |
| Ubuntu | Native queue consumed in the original 0.156.1 CLI conversation. | Native inventory works on 2.1.281. Live delivery remains unverified because this OS account reaches Claude's sign-in screen. |
| Windows 11 | Native queue consumed in the original 0.158.0-alpha.2.1 CLI conversation. The SSH account is elevated, so the provider-required `--no-daemon` mode was used. | Native channel Push consumed in the original 2.1.283 CLI conversation, using the installed npm distribution's native executable. |

The Claude probes used a disposable executor pairing fixture and a simulated
existing-heartbeat receipt. They prove native transport and readback, not a
production Nessie agent round trip. Receipts correctly remained
`written_to_transport`; consumption was checked separately against the native
assistant reply. Repeated Codex command IDs returned the same local receipt
without resending. Disabling discovery and input left the original clients
running. Probe clients were closed normally after testing.

## Five executor distributions

| Distribution | Verification |
| --- | --- |
| macOS CLI | Full executor suite: 626 cases, 616 passed, 10 platform-specific skips. Live Codex and Claude delivery. |
| Linux CLI | Full executor suite on Ubuntu with Node 22.23.3: 626 cases, 618 passed, 8 platform-specific skips. Live Codex delivery and both native inventories. |
| Windows CLI | Full executor suite with Node 22.23.3: 626 cases, 541 passed, 85 platform/setup skips. The packaged helper pass reran 100 state cases: 98 passed, 2 guest-artifact skips. Native Codex and Claude delivery. |
| macOS menu bar | Native `test-app.sh` build/tests passed. Headless shared-console rendering verified default-on state, immediate disable, independent connections and Claude setup. |
| Windows tray | Native common tests (14) and tray tests (26) passed; release native helper built. The same shared-console flows passed with the Windows IPC adapter. |

Windows Node 24 had a libuv assertion during forced test-process shutdown after
a passing HTTP relay assertion. Re-running the complete suite on Node 22,
matching CI, passed. An earlier Windows draft-write regression exposed missing
`O_NOFOLLOW`; atomic sibling replacement now preserves the outside target and
the existing regression passes. Terminal startup passed after the native
helper build finished.

## Product and contract checks

- Worker suite: 1,720 unit tests and 489 database tests passed without skips;
  worker build passed.
- Executor management suite: 166 tests passed without skips, including private
  and shared connection scope, external-session privacy and sharing refusal.
- Shared schema suite: 410 tests passed without skips. The seven focused signed
  heartbeat and session HTTP cases passed, including private and shared scopes.
- Changed-package type checks passed; the root lint gate passed across 42 tasks.
- Admin headless browser suite passed at 390 and 1,280 pixels: native overview,
  capabilities, absence of managed Share/Close, reload, Back and Forward.
  Both native overview screenshots were visually inspected.
- Shared-console screenshots and Claude setup were visually inspected.
- Channel regressions cover claim-before-write, order, disabling between events,
  expired authority, expired input, incarnation mismatch and no replay after an
  ambiguous transport write.
- Signed heartbeat HTTP and session routes have a durable focused Turbo suite:
  `DATABASE_URL=... pnpm exec turbo run test:executor-sessions --filter=@nessie/api`.

## Delivery boundary

This is source, native build and test verification. It does not claim that new
installers were installed over the user's daily executors or that production
has promoted the change. Required CI checks and PR merge are separate release
gates. Claude Desktop channel support, attaching a channel to a client already
running without one, and exact-turn Steer/Interrupt remain unsupported or
unverified and are reported that way in the capability response.
