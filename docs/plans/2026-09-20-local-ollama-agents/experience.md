# Experience and element inventory

Part of [Local Ollama agents](overview.md). Every element below exists to help
someone decide or act. Implementation may omit an unnecessary element; it may
not add one without extending this inventory with a concrete decision.

## Homes and doorways

The existing Agent Designer's **Model** field owns model/host selection:
`/agents/designer/:agentId?section=model` (new consumed section query, same
registered surface). The current agent detail, conversation header and existing
DM/addressing rows show the same availability component and open that section
when the viewer may edit. Readers see the state and a safe explanation, not an
unusable settings link. Agents remain explicitly labelled as agents; matching
a human's online/offline visual language does not put them in `GET /api/users`.

**Settings → Connections** owns the current person's local hosting consent and
device lifecycle, in a Local Ollama section with a stable consumed anchor.
The executor's existing detail page `/agents/executors/:executorId` hosts the
same model/status component, parametrized by host, for relay configuration.
The existing macOS menu app and Windows tray expose local pause/consent and a
doorway to that selected executor; Linux uses equivalent focused CLI verbs and
the same web detail. None gets a second model catalogue or agent-management UI.

The organisation's existing **Models** settings surface contains a compact
**Local Ollama** capability section distinct from the Ledger catalogue. It
uses existing people/team selectors to administer the typed setting; it does
not mix per-device inventory into Ledger model availability. The existing
Members person detail and Team settings reuse that scoped-setting control as
in-context doorways. The value and ancestor lock come from the one resolver.

## Friendly setup flows

**Direct desktop, Ollama running:** open an existing agent → Model → Local
Ollama. The app offers “Find Ollama on this computer” once, then immediately
shows detected compatible models. With one model there is no mandatory
dropdown interaction. Choose/confirm the model, see one concise native consent
describing whose prompts the computer may process, then “Use this model”. A
bounded test shows progress and either enables the existing Save action or
leaves the old selection intact with a specific remedy. The agent becomes
online when the server confirms the fresh binding. No executor wizard appears.

**Executor relay:** in the existing paired executor's local menu/tray choose
“Use Ollama for Nessie agents”. Discovery uses that executor's machine. The
person publishes only selected models. In the existing agent picker select
that computer and model; the host custodian confirms its exact prepared binding
locally. Existing reviewed policy mechanics remain visible only if this is a
real new scope to review. A person who administers both ends gets one composed
review explaining the exact change, not unrelated workspace/browser prompts.
The agent stays available while that executor and Ollama run even if Desktop
is closed. On Linux the equivalent proposed verbs are `local-models discover`,
`local-models enable`, `local-models pause`, `local-models resume`,
`local-models consent <request-id>` and `local-models forget`; machine-readable
output contains the same normalized states and no hidden extra functionality.

**Administrator enables a person:** choose the person in Models → Local Ollama,
set Enabled, and save through the scoped setting service. The person can then
set up their computer; no notification or permission request claims their
computer is already available. **Enable a team:** choose the team instead;
everyone's work in that exact team inherits it unless a more specific decision
or ancestor lock decides otherwise. The same control states the resolved value
and its origin. Ordinary members cannot turn an administrative denial into
permission by editing a raw key.

The normal path asks for no address, model-store folder, API key, shell command,
GPU name, heartbeat interval, connection epoch, context size or concurrency.
Advanced loopback/context controls are collapsed and appear only where their
specific repair is relevant. Consent identifies the destination and data
boundary in ordinary language; transport implementation terms stay in support
details rather than the main flow.

## Empty, unavailable and recovery states

| Observation | Copy and next action |
| --- | --- |
| Feature denied | “Local models are disabled for this work.” Show the deciding scope; eligible admins get the policy doorway. No self-enable action. |
| Browser on an unpaired computer | “Use Nessie Desktop on the computer running Ollama, or choose a paired executor.” Desktop download/open link and eligible executor selector; no fake scan. |
| Discovery in progress | “Looking for Ollama…” with Cancel; short bounded progress, no hardware telemetry. |
| Registered Ollama installed, not responding | “Open Ollama, then try again.” Open the registered app and Retry; do not start it automatically. |
| No verified install hint | “Ollama isn't responding on this computer.” Install/help link, Retry and the collapsed alternate local port. Do not assert it is absent. |
| Server replies, zero local chat models | “Ollama is connected. Add a chat model in Ollama, then refresh.” Link to the official model/setup help; no automatic multi-GB download. |
| Multiple models | Names plus the capability reason needed to choose; aliases grouped, no arbitrary recommendation or tokens/s ranking. |
| Model is incompatible | “This model can't use this agent's tools.” Select another model, or explicitly change the agent's tools through its existing form. |
| Model disappeared or changed | Name the selected model and “Choose a model” / “Use updated model”; retain the selected unavailable row rather than silently choosing another. |
| Version unsupported | “Update Ollama, then retry.” Official update help, observed version in expandable support details. |
| Loading/test slow | “Loading the model…” then a bounded timeout with Retry. No permanently spinning connection indicator. |
| Resource exhaustion | “This computer couldn't load that model.” Choose another installed model; advanced context reduction only if relevant. No unverified RAM/GPU advice. |
| Another local host mode is active | “Ollama is already connected through [executor/Desktop].” Reuse that connection or explicitly choose the other mode; never enroll duplicate devices silently. |
| Desktop credential store unavailable | “Nessie can't securely save this connection.” Platform-specific setup help and Retry; no insecure fallback switch. |
| Host offline or asleep | “Offline — open Nessie on the selected computer” or “start its executor”, matched to transport. Conversation can still accept a message with the stated bounded wait. |
| Queued while busy/offline | One run-status line “Waiting for this computer”, Cancel, then the existing retry/restart control on expiry. No accumulating chat apologies. |
| Policy/custodian identity revoked | “Access needs to be restored.” Only the entitled administrator/custodian gets the exact repair; signing in alone does not resume. |
| Prompt source denied | “This computer isn't allowed to process this conversation's context.” An editor may explicitly choose their own eligible host/model; do not reveal the withheld source or offer a bypass. |
| Viewer realtime disconnected | “Connection lost”; no stale online dot. Restore from the normal reconnect path. |

“Install/help” opens official documentation; this feature does not execute an
installer. “Open Ollama” launches only a verified registered app after the
click. A Linux CLI-only installation gets instructions rather than a generic
shell launcher. Model refresh is automatic for a published selection and on
opening its picker; Refresh exists for somebody who just installed a model and
does not want to wait. It never loads or changes the model.

## Exhaustive element inventory

Audience abbreviations below: **editor** passes the existing agent edit gate;
**reader** passes its visibility gate; **custodian** controls the selected
computer; **admin** has live organisation management authority.

| Surface / element | Audience | Decision/action enabled | Why necessary | State/source | What happens if omitted |
| --- | --- | --- | --- | --- | --- |
| Designer / Local Ollama option and current unavailable selection | Editor | Choose or repair this agent's inference lane | This is the capability's existing home | Unified model-options facade and selection DTO | Feature exists but cannot be selected or repaired |
| Designer / computer selector, only when choices differ | Editor | Pick which consented computer processes the prompts | Two computers imply different privacy and uptime | Entitled published hosts, explicit filter | The app would silently pick a data recipient |
| Designer / installed model selector | Editor | Choose model quality/capability from what is installed | Existing agent needs an explicit usable model | Host inventory names/digests/capabilities | The app would infer a model choice |
| Designer / incompatible reason beside a model | Editor | Choose a compatible model or edit tools | Prevents saving a choice that cannot run | Capability intersection and smoke result | Runtime fails after apparently valid setup |
| Designer / “Find Ollama on this computer” | Local desktop user | Permit local discovery once | Marks when native local observation begins | Native permission and server eligibility | Discovery would occur without local consent |
| Setup / bounded progress and Cancel | Person performing setup | Wait briefly or abandon setup | Discovery/test can take seconds | Explicit discovery/test state/deadline | A stopped app looks hung and cannot be escaped |
| Setup / native consent summary and Use/Cancel | Custodian | Authorise this origin, org, agent and model to process input | Server permission cannot consent for the computer | Signed prepared binding, native trusted origin | Remote editor could publish another person's computer |
| Designer / existing Save with test result | Editor | Commit the verified selection | Avoids a second save model or half-written selection | Prepared/confirmed binding and form dirty state | Selection may change before consent/test finishes |
| Setup / concise data-boundary and lifecycle sentence | Editor and custodian | Decide whether local processing meets the need | Local generation still uses hosted context/tools and some cloud services | Static accurate contract for chosen transport | Person may believe this is offline/private-to-device chat |
| Designer / pending consent + Cancel request | Editor | Wait for custodian or choose another route | Remote consent cannot be assumed | Expiring prepared binding | A half-configured agent appears usable |
| Designer / advanced loopback port | Custodian, on failed discovery | Reach a non-default local Ollama install | Handles real custom installations without a URL proxy | Native loopback validator and saved local config | Person must reconfigure a working installation |
| Designer / advanced context limit, only on need | Editor and custodian | Fit a supported model into local resources | Repairs context/resource failures | Observed ceiling and configured `numCtx` | User cannot make a smaller supported request |
| Setup / Open Ollama | Custodian with verified install | Start their existing application | Fixes installed-but-stopped state | Native registered-app evidence | They must hunt for the app after setup fails |
| Setup / official install/update/setup link | Custodian, matching error | Install/update/configure Ollama themselves | Nessie does not modify the runtime automatically | Classified missing-response/version state | Error gives no actionable way forward |
| Setup / Retry or Refresh | Custodian/editor with host permission | Verify a repair or newly installed model immediately | Avoids stale state after deliberate local action | Non-overlapping bounded scan | Person cannot tell whether their repair worked |
| Setup / “Use updated model” | Editor and custodian | Accept changed weights deliberately | Tag is mutable; consent is digest-bound | Old/new inventory digests, safe display name | Update silently changes the model or strands selection |
| Setup / active connection message | Custodian | Reuse an existing host or explicitly change mode | Prevents confusing duplicate connections | Local endpoint coordination plus entitled server host | Two bridges compete without explanation |
| Settings Connections / current connection row | Custodian | Find and manage their active local hosting | Durable home outside one agent's form | Host label, transport, state, published selection | Local sharing is hard to discover after initial setup |
| Settings Connections / pause/resume | Custodian | Temporarily stop/resume accepting inference | Gives immediate control over local resources | Local pause and server acknowledgment | Only quitting/revoking could stop work |
| Settings Connections / disconnect/forget confirmation | Custodian | Revoke pairing and remove local key/consent | Persistent consent must be withdrawable | Current host scope; existing confirm shell | A computer keeps serving after the user wants to leave |
| Settings Connections / secure-storage repair | Direct desktop custodian with failure | Configure OS secure storage or retry | Required to make protected pairing durable | Native typed key-store error | User sees a generic failure or accepts insecure storage |
| Models settings / Local Ollama user-or-team target | Admin | Choose exactly whom to enable | Required administrative scope distinction | Existing live people/team selectors | Admin can only enable everybody or nobody |
| Models/settings reuse / enable value and lock | Admin | Grant permission and decide whether lower scopes may override | Implements user/team policy and precedence | `ScopedSetting` typed service | Scope selection would be cosmetic |
| Any policy control / inherited value and lock explanation | Affected admin/person | Understand who can change the decision | Prevents impossible edits and support guesswork | `setAtScope`, `lockedAtScope`, `ScopedSettingGate` | UI offers an edit the service refuses |
| Members person detail / local enablement doorway | Admin | Enable the person where their access is managed | Required in-context discovery | Same scoped control, target person | Admin must discover an unrelated page |
| Team settings / same enablement doorway | Admin | Enable the team where team policy is managed | Same capability, correctly scoped | Same component, target team | Team enablement remains hidden |
| Agent avatar / online/offline badge | Reader in current addressing surfaces | Decide whether to expect a prompt response | User explicitly requested human-like availability | Agent availability facade, current TTL | Local agent looks always available |
| Conversation header / accessible state text and repair link | Reader; link only editor | Wait, act elsewhere, or repair this agent | Colour alone does not explain unavailable work | Same availability projection and doorway | Offline badge has no next step or accessible meaning |
| Conversation / existing run wait, Cancel, retry/restart | Run actor with existing permission | Stop waiting or retry after repair | A sent message must not disappear silently | Existing run lifecycle plus typed local reason | Offline work becomes a stranded run |
| Alert bell / one repairable health alert | Live repair-capable recipient | Return to the exact failed capability | Unattended failure needs a durable signal | Health revision + existing `UserAlert` | A recurring agent can remain broken silently |
| Executor detail / reused Local Ollama section | Custodian/host administrator | Publish model, inspect remedy or revoke hosting | The person may stand in the executor when configuring it | Same host facade/component | Relay setup has no reachable owning surface |
| Executor menu/tray / Use Ollama toggle and consent | Custodian | Permit discovery/hosting on this machine | Cloud admin cannot activate local access | Local policy/consent revision | No meaningful local permission boundary |
| Executor menu/tray / one status/remedy line | Custodian | See whether to start Ollama, reconnect or approve | Each failure has a distinct action | Same normalized host state | Local control says only “error” or falsely “online” |
| Executor menu/tray / pause/resume | Custodian | Stop/resume inference without stopping other executor work | Model hosting is separately consented | Shared local host lifecycle | User must disable unrelated capabilities |
| Executor menu/tray / open selected connection | Custodian | Reach the existing detailed configuration | Prevents a parallel native admin panel | Navigation deep link to exact host/executor | Native menu has to duplicate all controls |
| Executor CLI / discover, enable, consent, pause, resume, forget | Linux/headless custodian | Perform those same decisions without a tray | Linux is a first-class target | Same host service and schemas | Headless relay support cannot be configured |
| Error only / expandable support details | Custodian or support-authorised admin | Supply version/reason/request id for diagnosis | Repairs cases basic copy cannot resolve | Sanitized typed diagnostics, no paths or content | Support needs unstructured raw logs |
| Browser-only setup / Desktop open/download and executor choice | Eligible user without native bridge | Move to a host-capable surface | Browser cannot reach local Ollama safely | Native capability detection and entitled hosts | Page offers a scan that can never work |

Do not add standalone presence pages, GPU/RAM meters, model leaderboards,
connection counters, token/cost chips in conversation, generic “advanced” debug
forms, heartbeats, raw ids, repeated transport badges, new sidebar sections or
an independent executor model manager. None enables a decision in this brief.
Diagnostic ids belong only in expandable failure details. Queue length is not
a prediction of latency and does not merit a normal-screen counter.

## Reuse and accessibility

Extend `AgentAvatar` with the shared `PresenceBadge` rendering used by the
identity system; keep `IdentityTile` as the single image primitive. One
`AgentAvailability` shared component resolves the agent facade and renders
the dot plus accessible text. Do not shoehorn it into `PresenceProvider`'s
human rows or make a tree-wide local-agent context. Avoid subscribing from
each avatar: batch visible ids in the existing facade/cache and invalidate
on scoped realtime events.

Create one feature `LocalInferenceSetup` under
`components/features/agents/` (or a focused local-inference feature directory),
parameterized by host and editor rights. The Designer, Connections and executor
detail compose it. Settings reuse one `LocalInferenceEnablement` control with
scope. Existing `Dialog`, `TabBar`, `ScreenHeader`, `ScopedSettingGate`, facade
keys and navigation registry own structure. Native consent is the deliberate
OS trust boundary; it does not recreate the Designer form.

Text accompanies colour; online/offline is announced when relevant without
announcing every heartbeat. Focus stays on the initiating control after
refresh, failures use the form's existing error semantics, and every branch
is reachable by keyboard. Cold links, Back, mobile widths and modal cancel
must pass the navigation framework's durable browser cases. No card nesting
or new unthemed colours.
