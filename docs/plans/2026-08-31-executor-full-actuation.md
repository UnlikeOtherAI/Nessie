# Full browser & terminal actuation for the executor

> Status: proposed plan, not started — **revision 1**
> Closes the largest gap in the 2026-08-31 capability audit
> ([2026-08-31-grok-bot-vs-nessie-capability-audit.md](./2026-08-31-grok-bot-vs-nessie-capability-audit.md),
> dimensions 1 & 2, and the §6 Rule-zero risk).
> Grounded in the shipped executor: `executor/`, `packages/executor-manage/`,
> `worker/src/run/executor-toolset.ts`, `executor/guest/*.go`,
> `executor/vm/Sources/NessieExecutorVMCore/*.swift`.
> Supersedes nothing; it *finishes* two catalog rows
> (`packages/schemas/src/executor.ts` `ExecutorOperationKeySchema`) that today
> have no schema, no descriptor, and no daemon handler.

## 0. The one-paragraph version

Two executor verbs — `browser.act` (click/type/scroll/navigate) and
`command.run` (a validated argv) — are declared in the operation-key enum and
the logical-tool catalog, but they are dead: `descriptorFor` in
`worker/src/run/executor-toolset.ts` returns `null` for both (line 104-108), so
the model never sees them, and `executeExecutorCommand` in
`executor/src/daemon.ts` falls through to `EXECUTOR_BACKEND_UNAVAILABLE` (line
251). This is exactly the Rule-zero trap the audit names in §6: a catalog that
reads as "computer use" over an actuation surface that is really open-URL +
title/URL observe. The machinery to close it is almost entirely present — a
per-session Apple `Virtualization.framework` microVM with a Chromium already
launched under `--remote-debugging-port=9222`
(`executor/guest/browser_runtime.go:175`), a copy-on-write `/work` mount, a
tmux+Codex coding lane, and a deny-by-default forced-egress CONNECT gateway
pinned with `pinnedConnect` (`executor/src/egress-gateway.ts:120`). This plan
adds CDP-driven actuation and a confined argv runner **inside the existing guest
and the existing binding/grant/egress spine**, upgrades `browser.observe` from
title/URL-only to a bounded screenshot + accessibility snapshot so actuation is
targetable, and keeps every isolation invariant intact. It deliberately does
**not** build a persistent cloud VM, arbitrary desktop GUI actuation, a
cloud-supplied shell string, or a headless server executor as a new product.

**Scope honesty:** what this delivers is *governed, ephemeral, per-run computer
use inside a COW microVM against operator-allowlisted origins* — not Grok's
always-on persistent per-user Linux box, not a general internet shell, and not
screen-level actuation of native apps. Product copy must not claim "a cloud
computer for every user." §11 states the "not built" list as a binding decision,
not an omission.

## 1. What is shipped today (the exact starting line)

Read these before proposing a change; every anchor below was verified against
the tree.

- **Operation-key enum** — `packages/schemas/src/executor.ts:96-114`
  (`ExecutorOperationKeySchema`) declares `command.run`, `browser.act`, and
  `coding.attach/prompt/interrupt/close` alongside the shipped keys. Only the
  shipped keys have arg schemas: `ExecutorFileList/Read/WriteArgumentsSchema`,
  `ExecutorBrowserOpenArgumentsSchema`, `ExecutorBrowserObserveArgumentsSchema`
  (empty object, `:158`), `ExecutorCodingLaunch/ObserveArgumentsSchema`,
  `ExecutorWorkspacePromoteArgumentsSchema`. **There is no
  `ExecutorBrowserActArgumentsSchema` and no `ExecutorCommandRunArgumentsSchema`.**
- **Logical-tool catalog** — `packages/executor-manage/src/executor-logical-tools.ts:19,22`
  lists `command.run` ("Run a validated argv command…") and `browser.act`
  ("Perform an approved action…") as `requiresExplicitGrant: true` registry
  rows. They already mint `ToolRegistryEntry` rows and can be granted per-agent;
  they simply resolve to no tool.
- **Model-facing descriptor** — `worker/src/run/executor-toolset.ts:46-116`
  `descriptorFor` has explicit cases for `file.*`, `browser.open`,
  `browser.observe`, `coding.launch`, `coding.observe`, `workspace.review`,
  `sandbox.stop`. The `default` returns `null` with the standing comment "*A
  descriptor alone cannot enable an operation. Add its hardened companion
  backend and exact model schema before it is reachable.*" — `browser.act` and
  `command.run` hit that default.
- **Bundle binding** — `packages/schemas/src/executor.ts:428-469`
  (`ExecutorRunLaunchRequestSchema`) hard-codes two exact bundles: browser =
  `[browser.open, browser.observe, sandbox.stop]`; coding = `[coding.launch,
  coding.observe, workspace.review, sandbox.stop]`, `max(4)` keys, browser and
  coding mutually exclusive. `worker/src/run/executor-toolset.ts:143-208`
  re-checks the exact bundle (`hasExactBrowserBundle` requires
  `bindings.length === 3`) before it will surface *any* browser tool, and gates
  each on `input.agentToolPolicy?.[registryId] === true`.
- **Daemon dispatch** — `executor/src/daemon.ts:127-252` `executeExecutorCommand`
  validates expiry, `capabilityRevision`, local-policy membership,
  `argumentDigest`, and `runId`, then branches per key. Browser/coding delegate
  to `browser-session-manager.ts` / `coding-session-manager.ts`, which own the
  guest VM. Anything else → `EXECUTOR_BACKEND_UNAVAILABLE`.
- **Guest browser** — `executor/guest/browser_runtime.go`. Chromium is launched
  with a fixed argv (`fixedBrowserArguments`, `:166`) that already includes
  `--remote-debugging-address=127.0.0.1` and `--remote-debugging-port=9222`, a
  forced `--proxy-server=http://127.0.0.1:8137`, and a per-session
  `--user-data-dir` under `/work`. `observation()` reads only
  `http://127.0.0.1:9222/json/list` and returns `{title,type,url}` per target,
  capped at 32 targets / 64 KiB, stripping query+fragment
  (`safeObservedBrowserURL`, `:263`). **The CDP endpoint an actuator needs is
  already listening; nothing drives it.**
- **Guest control protocol** — `executor/guest/runtime_control.go`. Operations:
  `runtime.inspect`, `browser.open`, `browser.observe`, `coding.launch`,
  `coding.observe`, `coding.close`. Framed, length-prefixed, one in-flight
  request, `DisallowUnknownFields`, `guestControlPayloadMaxBytes = 32_768`
  (`protocol.go:18`). The TS side is `executor/src/guest-vm-control.ts`
  (`GuestVmControlClient`).
- **Guest coding lane** — `executor/guest/coding_runtime.go`. Codex/Claude in a
  tmux pane, `cwd = /work`, Codex network **disabled** via a launch-gated
  sandbox profile (`codexSandboxConfiguration`, `:62`), filesystem `deny` on the
  control dir, output never captured (only `#{pane_dead}` lifecycle,
  `maxCodingObserveBytes = 8_192`).
- **Egress** — `executor/src/egress-gateway.ts` is an owner-only-socket CONNECT
  proxy that resolves and pins with `@nessie/runtime` `pinnedConnect` (`:120`),
  deny-by-default to whole HTTPS origins (`egress-policy.ts`
  `compileExecutorEgressPolicy`, no ports/paths/wildcards). The guest has **no
  network adapter** (`VMConfiguration.swift:199`); its loopback proxy
  (`egress_proxy.go`) tunnels over a virtio socket to that host gateway. Codex
  uses a fixed `['https://chatgpt.com']` origin
  (`coding-session-manager.ts:18`); the browser uses
  `state.browserSandbox.allowedOrigins`.
- **microVM** — `executor/vm/Sources/NessieExecutorVMCore/VMConfiguration.swift`:
  COW `/work` shared dir `readOnly:false` (`:122`), runtime bundle
  `readOnly:true` (`:131`), disk `readOnly:true` (`:178`), **no `VZ…Network…`
  device** — control + egress are virtio sockets only. TTLs:
  `BROWSER_SESSION_MAX_MS = 10 min` (`browser-session-manager.ts:15`),
  `CODING_SESSION_MAX_MS = 20 min` (`coding-session-manager.ts:14`); stop
  discards the exact COW lease (`sandbox-workspace.ts:539`).
- **Admin surfaces** — `admin/src/components/features/executors/`:
  `ExecutorRunLauncherDialog.tsx` (bundle picker, lines 38-69 enumerate the
  reviewed bundles), `ExecutorDetailPanels.tsx`, `ExecutorWorkspacePromotionsPanel.tsx`,
  `ExecutorDesktopCompanionPanel.tsx`, `ExecutorCreatePanel.tsx`. Audit is wired
  through `emitAuditEvent` in `api/src/routes/executors.ts` and
  `executor-workspace-promotions.ts`.

The gap is therefore not "build a sandbox." It is "drive the CDP socket that is
already open, add one confined argv runner in the guest, give the model two
schemas, two descriptor cases, and two daemon branches, and widen exactly two
bundles — without loosening one isolation boundary."

## 2. Design rules (decided, not open)

| Question | Decision | Why |
|---|---|---|
| Model supplies a shell string for `command.run`? | **Never.** Structured `{ program, args[] }` only; the guest `exec`s the argv directly (no shell, no `sh -c`). | A cloud-supplied shell string is injection-by-construction and defeats the argv-audit story. Mirrors the daemon's existing "positional Codex prompt after `--`" discipline (`executor.ts:161-171`). |
| `command.run` reaches the network? | **No.** The argv runs with the same Codex-style launch-gated profile: `network.enabled=false`, `cwd` pinned to `/work`, control dir `deny`. | The browser lane is the *only* actuation lane that touches allowlisted origins; a general shell with egress is Grok's high-blast-radius model, which §9 of the audit says Nessie deliberately rejects. |
| `browser.act` free-form CDP / `Runtime.evaluate`? | **No.** A closed verb set — `navigate`, `click`, `type`, `press`, `scroll`, `select` — addressed by a **backend node id from the observation**, never a raw selector, XPath, or script. | Arbitrary JS in the page is arbitrary egress and arbitrary DOM read; the whole point of the deny-by-default origin gate is that the *executor*, not the model, decides where bytes go. |
| Where does the target address come from? | The **observation returns stable `nodeId`s**; `browser.act` references one. Model never invents a coordinate or selector. | Coordinate-replay is Grok's brittle demo-learning failure mode (audit §7); a11y-node addressing generalises and is auditable. |
| Persistent per-user VM? | **No** — keep ephemeral per-run, extend only the *TTL ceiling* and add explicit human-driven session hold. §7 states the full tradeoff. | A persistent VM with retained cookies/creds is precisely the "Bots are not a security boundary" model Nessie is ahead of. Persistence is a convenience gap we close differently (§7). |
| Screenshot bytes to the model? | **Yes, bounded** — one downscaled WebP per `browser.observe`, hard byte cap, plus a pruned a11y tree. Never full-resolution, never every frame. | Actuation is untargetable from title/URL alone; but unbounded pixels are a context-window and exfiltration hazard. |
| New egress policy for actuation? | **None.** Every byte still leaves through the one `pinnedConnect` gateway and the same origin allowlist. | A second SSRF policy is the divergence AGENTS.md "Outbound egress is IP-pinned" forbids. |
| Headless server executor first-classed here? | **No** — out of scope, noted in §8. | It is a distribution decision (App Store build omits the executor), independent of actuation. Fold it in later, not by widening this change. |

## 3. `browser.act` — driving the CDP socket already in the guest

### 3.1 Observation must become targetable first (`browser.observe` upgrade)

Actuation is useless if the model cannot see what to act on. Today
`browser.observe` returns `{title,type,url}` only. Upgrade it — **in the guest,
behind the same 64 KiB observe frame** (`browser_runtime.go`
`maxBrowserObserveBytes`):

- **Accessibility snapshot.** After `/json/list` yields the page target, open a
  CDP session to that target's `webSocketDebuggerUrl` (loopback
  `127.0.0.1:9222`, already reachable via `dialBrowserDevTools`), call
  `Accessibility.getFullAXTree` (or `DOMSnapshot.captureSnapshot`), and project
  it to a **pruned node list**: `{ nodeId, role, name, value?, bounds }` for
  interactable/labelled nodes only, capped (e.g. ≤ 200 nodes, names truncated
  to 256 bytes each, whole payload ≤ a new `maxBrowserSnapshotBytes` ceiling).
  `nodeId` is the CDP backend node id — the stable handle `browser.act`
  references.
- **Bounded screenshot.** `Page.captureScreenshot` → downscale to a fixed max
  edge (e.g. 1024 px) as WebP, hard-capped (e.g. ≤ 256 KiB). Returned as
  `{ mime, dataBase64 }`, so it can ride the existing image-in-context path
  (`worker/src/run/message-attachments.ts` inlines `ProviderMessage.images`,
  ~1500 tokens each) rather than a bespoke channel. Only vision-capable
  connectors receive it; others get the a11y tree only (the same honest
  degradation the codebase already applies).
- **New guest ceilings** live beside the existing ones in `browser_runtime.go`
  (`maxBrowserSnapshotBytes`, `maxBrowserScreenshotBytes`, `maxBrowserAXNodes`),
  re-asserted on the TS side in `guest-vm-control.ts`
  (`parseBrowserObservation` gains the new fields with the same
  `DisallowUnknownFields`-style key allow-list it uses today).

Because the observation payload can now approach the frame cap, either raise the
guest control frame budget for observe responses **or** split observe into
`browser.observe` (a11y + metadata) and a separate screenshot fetch. Recommend
**keeping one `browser.observe`** and choosing the WebP cap so the combined
frame stays under `guestControlFrameMaxBytes = 65_536` for the a11y half and
carrying the screenshot as a second framed chunk — do not exceed the protocol's
existing 64 KiB frame without bumping `protocol.go` deliberately and updating
`GuestControlFrameTests.swift`.

### 3.2 The actuation verb

- **Schema** — add `ExecutorBrowserActArgumentsSchema` to
  `packages/schemas/src/executor.ts`, a `discriminatedUnion('action', …)`:
  - `{ action: 'navigate', url }` — re-validated against the origin allowlist
    exactly as `browser.open` is (`assertExecutorEgressOrigin`); a navigate to a
    non-allowlisted origin is `EXECUTOR_BROWSER_DENIED`, never a silent redirect.
  - `{ action: 'click', nodeId }` / `{ action: 'type', nodeId, text }` (text
    length-capped) / `{ action: 'press', key }` (from a fixed key enum, not
    arbitrary chords) / `{ action: 'scroll', nodeId?, deltaY }` /
    `{ action: 'select', nodeId, value }`.
  - No selector, no XPath, no script, no coordinate. `nodeId` must be a
    non-negative int; the guest maps it to the CDP backend node and refuses an
    unknown/stale id (`EXECUTOR_BROWSER_STALE_NODE`).
- **Descriptor** — add a `case 'browser.act':` in
  `worker/src/run/executor-toolset.ts` `descriptorFor`, emitting the JSON-Schema
  mirror of the union (the file hand-writes JSON Schema per case; follow that
  style). It becomes reachable only when the browser bundle is present and
  `agentToolPolicy['executor.browser.act'] === true`.
- **Daemon dispatch** — add a `command.operationKey === 'browser.act'` branch in
  `executor/src/daemon.ts` that `safeParse`s the args and delegates to
  `browserSessions.act(command, runId)`, returning `EXECUTOR_BROWSER_DENIED` on
  parse failure (mirrors the `browser.open` branch, `:205-212`).
- **Session manager** — add `act` to `ExecutorBrowserSessionManager`
  (`browser-session-manager.ts`). It looks up the live `ActiveBrowserSession`
  for the run (same `activeByRun` map that `observe` uses), and calls a new
  `session.actBrowser(action)` on the `GuestVmSession`. A `navigate` action
  re-runs `assertExecutorEgressOrigin(url, egressSettings)` *before* it reaches
  the guest — the origin gate is enforced on the host, not trusted to the guest.
- **Guest control** — add `browser.act` to `runtime_control.go`'s
  `decodeRuntimeControlRequest` switch and `handleRuntimeControlRequest`, and an
  `act(action)` method on `browserRuntime` in `browser_runtime.go` that drives
  CDP: resolve the page target, then issue the minimal CDP command
  (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` /
  `DOM.scrollIntoViewIfNeeded` + click, `Page.navigate` for navigate). The guest
  re-validates: navigate URL through `validBrowserURL` **and** the guest cannot
  reach a disallowed origin anyway because the forced proxy + host gateway drop
  it. Return a small typed ack (`{ status: 'acted', settledUrl }`), never page
  content — reads come only through `browser.observe`.

### 3.3 Bundle change

`browser.act` must join the browser bundle. Change **both** enforcement points
together (they must agree or the toolset silently drops the tool):

- `packages/schemas/src/executor.ts` `ExecutorRunLaunchRequestSchema`: the
  browser bundle becomes `[browser.open, browser.observe, browser.act,
  sandbox.stop]`, and `max(4)` stays (still four). Update the `superRefine`
  message and membership check.
- `worker/src/run/executor-toolset.ts`: `hasExactBrowserBundle` currently
  asserts `bindings.length === 3` / `browserBindings.length === 3` and lists the
  three keys. Make it 4 and include `browser.act`. `browserBindings` filter and
  the `entries` carve-out (`:144-197`) both enumerate the browser keys — extend
  both.
- `admin/.../ExecutorRunLauncherDialog.tsx:62`: the browser bundle option's
  `operationKeys` gains `browser.act`.

Grant remains **per-operation**: an owner can still deny `executor.browser.act`
on an agent while allowing `browser.open`/`observe`, because the toolset gates
each key on `agentToolPolicy[registryId] === true` independently. A read-only
browsing agent and an actuating agent are one grant apart.

## 4. `command.run` — a confined argv runner in the guest

### 4.1 Schema and dispatch

- **Schema** — `ExecutorCommandRunArgumentsSchema` in
  `packages/schemas/src/executor.ts`:
  `{ program: string(1..256), args: string[](≤64, each ≤4096), cwd?: relative
  path within workspace }`, `.strict()`. No `env`, no shell, no absolute cwd, no
  `..`. Result cap mirrors the coding lane: bounded combined stdout+stderr
  (reuse the 8 KiB terminal ceiling class, tunable up to the 64 KiB command
  result cap in `executor-commands.ts` `MAX_RESULT_BYTES`).
- **Descriptor** — `case 'command.run':` in `descriptorFor`.
- **Daemon** — `command.operationKey === 'command.run'` branch delegating to a
  new **command-session manager** (see 4.2), parse-failure →
  `EXECUTOR_COMMAND_DENIED`.
- **Guest** — new `command_runtime.go` beside `coding_runtime.go`, reusing its
  exact hardening: `exec.CommandContext` with a timeout, `command.Dir = "/work"`
  (or a validated sub-path), the **same launch-gated sandbox profile** Codex
  uses (`network.enabled=false`, control-dir `deny`), a fixed minimal `PATH`,
  no ambient `HOME`/cloud/SSH/Docker env, non-root guest uid, and a
  `boundedCommandOutput` that fails closed on overflow (copy
  `boundedCodingOutput`, `coding_runtime.go:295`). Add `command.run` to
  `runtime_control.go`'s decode switch and handler, and `runCommand` to
  `guest-vm-control.ts` with a strict result parser.

### 4.2 Which workspace, and which bundle

`command.run` is a **workspace_sandbox** operation, not a coding-session one. It
belongs with the file/review operations on a shared COW workspace, so a run can
write a file, run a command against it, and review the delta for promotion. Two
options, decide **A**:

- **(A, recommended) A new command bundle** `[command.run, workspace.review,
  sandbox.stop]` (+ optionally `file.write`), analogous to the browser and
  coding bundles, with its own `workspace_sandbox` session so the argv runner
  has a live VM to run inside. This keeps `command.run` off the read-only
  file-op path (which has no VM today — `file.*` operate on the COW snapshot
  directly via `workspaceForRun`, no guest) and gives the human a reviewable
  change set. Add it to `ExecutorRunLaunchRequestSchema` as a third bundle
  (relax `max(4)`→ keep 4: `command.run, file.write, workspace.review,
  sandbox.stop`), to `executor-toolset.ts` (`hasExactCommandBundle`), and to the
  launcher dialog.
- (B) Fold `command.run` into the coding bundle. Rejected: the coding lane's VM
  is credential-bearing (Codex auth home) and single-purpose; letting a general
  argv run beside it widens what a command can reach toward that auth home.

The command session manager mirrors `coding-session-manager.ts`: one VM per run,
`activeByRun`, a stop timer, lease-bound COW, `stopAll` on daemon fence. Reuse
`startGuestVmSession` — it already accepts the workspace lease and egress policy;
pass an **empty allowlist** (or omit egress entirely) so `command.run` gets no
network, enforced both by the empty origin set and by the guest's disabled-network
profile.

### 4.3 Non-negotiables restated on the runner

No ambient credentials (fresh env, no host `HOME`), non-root, `cwd` confined to
the COW `/work`, wall-clock + output caps from the signed descriptor
`limits.maxCommandRuntimeSeconds` / `maxResultBytes`
(`executor.ts:249-255`, already part of the capability descriptor), no shell
interpolation, no network. The COW workspace is discarded on `sandbox.stop` /
TTL exactly as browser/coding sessions are; nothing a command writes reaches the
host root without the **unchanged** human-gated `workspace.promote` path
(`executor-protocol.md` §9, `native-helper.ts` `applyNativePromotion`).

## 5. Isolation invariants (unchanged — enumerated so review can check each)

Every one of these already holds for `browser.open`/`coding.launch`; the plan's
correctness is that actuation inherits them without a new path.

1. **microVM per session.** `browser.act` and `command.run` run inside the same
   `startGuestVmSession` VM the bundle already booted — no second VM, no
   long-lived VM. Apple `Virtualization.framework`, no network device, COW
   `/work`, read-only runtime + disk (`VMConfiguration.swift`).
2. **Egress only through the pinned gateway.** No actuation verb opens a socket.
   Browser bytes traverse guest loopback proxy → virtio tunnel → owner-only
   CONNECT gateway → `pinnedConnect` (`egress-gateway.ts:120`). `command.run`
   gets **no** egress. `browser.act navigate` is origin-checked on the host
   before it reaches the guest and again dropped by the gateway if it slips.
   **No divergent SSRF policy** — AGENTS.md "Outbound egress is IP-pinned."
3. **COW never touches host root.** `command.run` writes only to the run's COW
   lease; `sandbox-workspace.ts` `workspaceForRun` + the promotion journal are
   the only bridge, and promotion is human-gated and unchanged.
4. **`workspace.promote` untouched.** No actuation verb can promote; the native
   helper still requires the fresh-verification continuation and digest recheck
   (`executor-protocol.md` §9). Model, PA, browser, and argv cannot mint a host
   write.
5. **Per-agent policy + exact-bundle binding.** Each new key is a
   `requiresExplicitGrant` registry row (`executor-logical-tools.ts`), gated on
   `agentToolPolicy[key] === true`, and only surfaced inside its exact reviewed
   bundle (`hasExact*Bundle`). New descriptor operations start **denied** — the
   `ExecutorAgentOperationGrant` "new operations start denied" rule
   (`executor-protocol.md` §3) means adding `browser.act`/`command.run` grants
   no existing agent anything until an owner flips the grant.
6. **Consent bounds on returned data.** Screenshot + a11y snapshot are byte- and
   node-capped in the guest *and* re-capped in `guest-vm-control.ts`; command
   output is capped by the descriptor limit and `boundedCommandOutput`. Nothing
   returns raw terminal panes or full-resolution frames.
7. **Fail-closed on control-plane loss.** `serveExecutor`'s poll-failure path
   already `stopAll()`s browser and coding sessions on a lost/fenced control
   plane (`daemon.ts:315`); the command manager joins that `stopAll` set so a
   revoked grant tears down a running argv too.

## 6. Rule zero — the home and the doorways

A capability is not done until a person can reach it (AGENTS.md "Rule zero").

- **Owning surface.** The executor detail area
  (`admin/src/components/features/executors/`). `ExecutorRunLauncherDialog.tsx`
  is the doorway that *starts* an actuating run: add the widened browser bundle
  (now with `browser.act`) and the new command bundle to its option list
  (`:38-69`). `ExecutorDetailPanels.tsx` shows live sessions
  (`ExecutorSessionSummaryResponse`) — extend it to render the actuation session
  and its bounded observation (the latest screenshot thumbnail + a11y summary)
  so a human watching a run can *see* what the agent is doing, not just that a
  session exists.
- **Grant doorway.** The two new keys are per-agent grants in the executor
  access view (`ExecutorAccessViewResponse.operationGrants`) and must appear as
  toggles in the Agent Designer tool-policy surface, alongside the existing
  executor grants, labelled from the logical-tool `label`/`description`. Because
  they are `requiresExplicitGrant`, an owner must consciously enable "Act in
  sandbox browser" / "Run workspace command" per agent — the audit's §6 worry
  ("reads as computer use when it isn't") is answered by making the grant the
  place the capability is named.
- **Promotion doorway.** `command.run` results feed `workspace.review` →
  `ExecutorWorkspacePromotionsPanel.tsx` ("Your reviewed drafts"), the unchanged
  human-gated path to host writes.
- **Distribution constraint (state it, do not silently ship half).** The
  executor exists **only in the Developer-ID desktop build**; the sandboxed Mac
  App Store / TestFlight build deliberately omits it
  (`desktop/src-tauri/src/executor_companion/runtime.rs`,
  `executor-integration.md:895`). Actuation therefore reaches only the
  Developer-ID install base and owner-managed headless daemons. This is a known,
  written limitation, not a regression — but the launcher dialog and Agent
  Designer must **degrade honestly** where no executor is enrolled (they already
  resolve availability via `resolveExecutorAvailability`; the "no candidate"
  reason codes must render as a plain "no executor paired," never a dead
  button). **First-classing a headless server executor is out of scope here**
  (§8); the CLI daemon path already supports owner-managed headless machines
  (`executor-integration.md:895`) and needs no actuation-specific change.

## 7. Persistence — the decision, with the tradeoff stated

**Recommendation: keep ephemeral, per-run, time-boxed sessions. Do NOT build a
persistent per-user VM. Extend only (a) the TTL ceiling and (b) an explicit,
human-visible "hold this session open" affordance bounded by a hard maximum.**

Why not persistence, concretely:

- A persistent VM's value is *retained state* — cookies, logged-in sessions,
  installed tools, a home directory. That retained state is exactly the
  "user-is-the-boundary, creds shared on one machine" model the audit (§5, §9)
  names as Nessie's decisive lead over Grok. A persistent browser profile means
  a later run — possibly a *different agent* the same user granted — inherits the
  first run's authenticated cookies. The COW-discarded-on-stop design is what
  makes "one run cannot exfiltrate another run's session" true by construction.
- The isolation story ("no ambient credentials," §5) depends on the guest
  starting from a clean COW snapshot every time. Persistence reintroduces ambient
  authority as a *feature*, and every disclosure/egress guard would then have to
  reason about accumulated state instead of a fresh VM.

What we do instead to close the *convenience* half of the gap:

- **Raise the ceilings, keep them bounded.** 10 min (browser) / 20 min (coding)
  are short for real work. Make the max a per-descriptor limit
  (`ExecutorCapabilityDescriptor.limits`) with a sane cap (e.g. 60 min) and a
  per-run override the launcher offers, not an unbounded hold.
- **Explicit session hold, not implicit persistence.** Allow a human watching a
  run to extend a live session (reset the stop timer) up to the hard max. This
  is a person keeping *their own* run alive, not a shared always-on box — the COW
  is still discarded when it finally stops, and no second run inherits it.
- **If a future product truly needs retained per-user workspace state**, it is a
  separate, explicitly-decided plan with its own threat model (encrypted
  per-user COW base image, re-consented on each attach, never shared across
  agents), not a quiet TTL removal. Naming it here so the decision is not made by
  accident.

Net: we buy back "sessions long enough to finish a task" without buying the
shared-credential blast radius that persistence implies.

## 8. What is deliberately NOT built (scope honesty — binding)

- **No persistent cloud VM / hosted per-user Linux box.** §7. Ephemeral per-run
  microVM only.
- **No arbitrary desktop GUI actuation.** Actuation is web (CDP) + workspace
  argv. There is no screen-pixel clicking of native apps, no window management,
  no OS-level input injection. The audit's "full computer use" is browser +
  terminal *inside the sandbox*, not the host desktop.
- **No cloud-supplied shell string, no `sh -c`, no free-form CDP script.**
  Structured argv and a closed a11y-addressed action set only (§2).
- **No `command.run` network access.** The browser lane is the only
  origin-allowlisted egress; a general networked shell is out of scope and
  against the isolation model.
- **No new egress/SSRF policy.** One `pinnedConnect` gateway, one origin
  allowlist.
- **No learn-by-demonstration.** A separate audit gap (§6.3), not this plan.
- **Headless server executor not first-classed** beyond the existing CLI daemon;
  App Store build still omits the executor. Distribution is a later decision.
- `coding.attach/prompt/interrupt/close` remain declared-but-unshipped; this
  plan does not wake them (the single-prompt Codex launch is the shipped coding
  contract). If desired, they are a follow-up with the same schema/descriptor/
  daemon/guest quartet — flagged, not bundled.

## 9. Disclosure, audit, and untrusted-framing

- **Audit hash-chain.** Executor lifecycle already emits `emitAuditEvent`
  (`api/src/routes/executors.ts`, `executor-workspace-promotions.ts`) into the
  per-org tamper-evident chain (`packages/db/src/audit-chain.ts`). Every
  `browser.act` and `command.run` dispatch already creates a durable `ToolCall`
  row inside the dispatch transaction (`executor-toolset.ts:284-294`) and a
  command receipt (`executor-commands.ts`). **Add an audit-chain entry per
  actuation command** — action kind + target `nodeId`/argv program (never the
  full page, never command output), org-scoped — so a browser click and a
  workspace command are as auditable as a promotion. The bytes in the chain must
  be a bounded, content-free descriptor (mirror the promotion audit events,
  which record digests, not payloads).
- **Disclosure sink — the honest answer.** The `ConsumedSourceSink` /
  `computeReplyBasis` machinery
  (`worker/src/run/execute/disclosure-basis.ts`) stamps a *provenance basis* for
  **org-internal privileged sources** (memories, KB pages, transcript turns) so
  a run cannot launder them into a room its audience cannot read. Executor
  browser/terminal reads are **external, operator-allowlisted, public-web
  content**, not org-scoped privileged sources, so they do **not** add a
  `BasisScope` — treating a public web page as a restricting basis would be
  wrong and would over-restrict replies. **However**, that content is *untrusted
  external input* and must be framed as such at insertion. The audit's §10
  caveat — "untrusted-framing of live tool results is not uniform" — applies
  directly: `browser.observe` a11y text/screenshots and `command.run` output
  must enter the context window wrapped as untrusted external data (the existing
  `BEGIN/END UNTRUSTED EXTERNAL DATA` convention used for dashboard sources and
  compaction re-entry), so an actuation result cannot smuggle an instruction.
  This is the one disclosure-side change the feature owes.
- **Exception to watch:** if a future change lets the browser reach an
  *authenticated internal* origin (an org's own app behind SSO), that read *is*
  privileged and would need a basis. Today the origin allowlist is
  operator-configured whole HTTPS origins with no credential injection, so the
  reads are public-shaped. Note it so the boundary is not crossed silently.

## 10. Testing and staged rollout

**Test suites** (extend, do not fork):

- `executor/test/` — `browser-session-manager.test.ts`,
  `coding-session-manager.test.ts`, `guest-vm-control.test.ts`,
  `egress-gateway.test.ts` are the pattern. Add `command-session-manager.test.ts`
  and extend the browser test for `act` and the upgraded `observe` (assert the
  navigate origin gate rejects a non-allowlisted URL *before* the guest is
  called; assert screenshot/a11y byte caps; assert a stale `nodeId` is refused).
- `executor/guest/*_test.go` — `coding_runtime_test.go`, `protocol_test.go`,
  `guest-runtime.test.ts` patterns. Add guest-side tests for `browser.act` CDP
  command construction, the a11y projection cap, and `command_runtime.go`
  (network-disabled, cwd-confined, output-overflow fails closed). Reuse the
  Codex sandbox-conformance launch-gate style (`coding_runtime.go:233`) for the
  command runner's network-denial proof.
- `worker/src/run/executor-toolset.test.ts` — add the two descriptor cases and
  the widened/added bundle gates (assert `browser.act` is invisible without the
  4-key bundle and without the per-agent grant; assert the command bundle).
- **Mock harness** — `@nessie/mock-llm` (`packages/mock-llm`) +
  `worker test:smoke`: add a scenario that grants the browser bundle, observes,
  acts on a `nodeId`, and re-observes, plus a command-bundle scenario, so the
  full enqueue→command→receipt→result loop is exercised end to end.
- **Swift** — `executor/vm/Tests/NessieExecutorVMCoreTests/` if the frame budget
  or control session changes (`GuestControlFrameTests.swift`).
- **UI verification** — Playwright headless against `http://localhost:5455`, the
  executor launcher dialog and detail panel with the new bundles rendered
  (AGENTS.md "Verification").

**Staged rollout:**

1. **Stage 0 — observe upgrade only.** Ship the a11y snapshot + bounded
   screenshot on the *existing* browser bundle. No new verb, no bundle change.
   Immediately makes the shipped browser lane more useful and de-risks the CDP
   plumbing before actuation rides on it.
2. **Stage 1 — `browser.act`.** Add the verb, widen the browser bundle to 4,
   default-denied grant. Dogfood on allowlisted origins.
3. **Stage 2 — `command.run`.** New command bundle, network-disabled runner,
   review→promote flow.
4. **Stage 3 — session hold + raised TTL ceiling** (§7), only after 1-2 are
   stable, since a longer session multiplies the blast radius of any actuation
   bug.

Each stage is independently revertible (a descriptor case + a bundle entry), and
each ships its audit entry and untrusted-framing in the same change.

## 11. Defects this closes / risks it must not open

**Closes:**

- The Rule-zero trap (audit §6): `browser.act` / `command.run` declared in the
  catalog but resolving to `null`/`EXECUTOR_BACKEND_UNAVAILABLE`. After this,
  either they work behind an explicit grant, or the catalog row is honestly
  reachable.
- The untargetable-observation gap: title/URL-only observe made actuation
  impossible even in principle.

**Risks to hold the line on (each maps to a §5 invariant):**

- **Screenshot/a11y as an exfiltration or context-bloat vector** → hard byte and
  node caps in the guest *and* re-checked in `guest-vm-control.ts`; vision-gated
  delivery; untrusted-framing (§9).
- **`navigate` as an open-redirect around the origin gate** → host-side
  `assertExecutorEgressOrigin` before the guest call, plus the gateway drop.
  Never trust the guest to enforce the allowlist alone.
- **`command.run` as a network or credential escape** → network-disabled
  launch-gate (Codex-style conformance proof), no ambient env, non-root,
  cwd-confined, no shell.
- **Bundle drift** → the schema (`ExecutorRunLaunchRequestSchema`), the toolset
  (`hasExact*Bundle`), and the launcher dialog must change in one commit; a
  disagreement silently drops the tool (the toolset's `entries` carve-out
  returns `[]` when the exact bundle is absent), which reads as "feature
  missing" not "bug."
- **Persistence creep** → §7 is binding; a TTL ceiling is not persistence, and
  the COW is always discarded on stop.
- **App Store confusion** → the feature is Developer-ID-only; availability
  degrades honestly, product copy is bounded (§6, §8).

## 12. File-change checklist (concrete)

- `packages/schemas/src/executor.ts` — `ExecutorBrowserActArgumentsSchema`,
  `ExecutorCommandRunArgumentsSchema`, upgraded observe result type, widened
  browser bundle + new command bundle in `ExecutorRunLaunchRequestSchema`.
- `packages/executor-manage/src/executor-logical-tools.ts` — descriptions
  already present; no key change needed (both keys exist).
- `worker/src/run/executor-toolset.ts` — `descriptorFor` cases for `browser.act`
  and `command.run`; `hasExactBrowserBundle` → 4 keys incl. `browser.act`;
  `hasExactCommandBundle`; extend `browserBindings`/`entries` carve-outs.
- `executor/src/daemon.ts` — `browser.act` and `command.run` dispatch branches.
- `executor/src/browser-session-manager.ts` — `act`; upgraded `observe`.
- `executor/src/command-session-manager.ts` — **new**, modelled on
  `coding-session-manager.ts`, empty egress allowlist.
- `executor/src/guest-vm-control.ts` — `actBrowser`, `runCommand`, upgraded
  `observeBrowser` parser + caps.
- `executor/guest/browser_runtime.go` — CDP `act`; a11y + screenshot in
  `observation()`; new byte/node ceilings.
- `executor/guest/command_runtime.go` — **new**, modelled on
  `coding_runtime.go` hardening.
- `executor/guest/runtime_control.go` — `browser.act` + `command.run` in decode
  switch + handler.
- `admin/src/components/features/executors/ExecutorRunLauncherDialog.tsx` —
  bundle options; `ExecutorDetailPanels.tsx` — live observation view; Agent
  Designer tool-policy — the two new grant toggles.
- `api/…` executor command dispatch — per-actuation `emitAuditEvent`.
- Worker context insertion — untrusted-framing of observe/command results.
- Tests as in §10; docs: update `docs/executor-protocol.md` (operation table,
  §10 state contract) and `docs/plans/2026-08-11-executor-integration.md`, and
  `CLAUDE.md`/`AGENTS.md` executor notes, in the same turn.
