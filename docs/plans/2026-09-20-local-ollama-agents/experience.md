# Experience and element inventory

Part of [Local Ollama agents](overview.md). Every element below exists to help
someone decide or act. Implementation may omit an unnecessary element; it may
not add one without extending this inventory with a concrete decision.

## Homes and doorways

The existing Agent Designer's **Model** field owns model/host selection:
`/agents/designer/:agentId?designerSection=model` (new consumed query value,
same registered surface). `AgentDesignerForm` gains that real section and the
navigation registry owns the link. The current agent detail, conversation header and existing
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

**Direct desktop, Ollama running:** open an existing person-owned agent → Model → Local
Ollama. The app offers “Find Ollama on this computer” once, then immediately
shows detected compatible models. With one model there is no mandatory
dropdown interaction. Choose/confirm the model, see one concise native consent
describing whose prompts the computer may process, then “Allow this model”. A
bounded test and signed confirmation produce an inactive, exact consent. They
either enable the existing Save action or leave the old selection intact with
a specific remedy. **Save is the only activation action.** The agent becomes
online when the server confirms the fresh binding. No executor wizard appears.

**Executor relay:** on the agent owner's existing paired executor, choose
“Use Ollama for Nessie agents”. Discovery uses that executor's machine. The
person publishes only selected models. In the existing agent picker select
that computer and model; the owner/custodian confirms its exact prepared binding
locally, then the editor commits it with Save. Existing reviewed policy mechanics remain visible only if this is a
real new scope to review. A person who administers both ends gets one composed
review explaining the exact change, not unrelated workspace/browser prompts.
No teammate can select or receive inventory from that host. The agent stays available while that executor and Ollama run even if Desktop
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
| More than one loopback daemon answers | “Choose which local Ollama to use.” Show canonical local sockets and their reported model summaries; never choose the fastest response. |
| Registered Ollama installed, not responding | “Open Ollama, then try again.” Open the registered app and Retry; do not start it automatically. |
| No verified install hint | “Ollama isn't responding on this computer.” Install/help link, Retry and the collapsed alternate local port. Do not assert it is absent. |
| Server replies, zero local chat models | “Ollama is connected. Add a chat model in Ollama, then refresh.” Link to the official model/setup help; no automatic multi-GB download. |
| Multiple models | Names plus the capability reason needed to choose; aliases grouped, no arbitrary recommendation or tokens/s ranking. |
| Cloud/unknown-locality model | “This model does not run entirely on this computer.” Keep it ineligible; link to Ollama local-model help, never suggest a suffix rename. |
| Model is incompatible | “This model can't use this agent's tools.” Select another model, or explicitly change the agent's tools through its existing form. |
| Model disappeared or changed | Name the selected model and “Choose a model” / “Use updated model”; retain the selected unavailable row rather than silently choosing another. |
| Version unsupported | “Update Ollama, then retry.” Official update help, observed version in expandable support details. |
| Loading/test slow | “Loading the model…” then a bounded timeout with Retry. No permanently spinning connection indicator. |
| Resource exhaustion | “This computer couldn't load that model.” Choose another installed model; advanced context reduction only if relevant. No unverified RAM/GPU advice. |
| Another local host mode is active | “Ollama is already connected through [executor/Desktop].” Reuse that connection or explicitly choose the other mode; never enroll duplicate devices silently. |
| Desktop credential store unavailable | “Nessie can't securely save this connection.” Platform-specific setup help and Retry; no insecure fallback switch. |
| Host offline or asleep | “Offline — open Nessie on the selected computer” or “start its executor”, matched to transport. Conversation can still accept a message with the stated bounded wait. |
| Queued while busy/offline | One run-status line “Waiting for this computer”, Cancel, then the new authorized Restart action in the same conversation after expiry. No accumulating chat apologies. |
| Policy/custodian identity revoked | “Access needs to be restored.” Only the entitled administrator/custodian gets the exact repair; signing in alone does not resume. |
| Prompt source denied | “This computer isn't allowed to process this conversation's context.” An editor may explicitly choose their own eligible host/model; do not reveal the withheld source or offer a bypass. |
| Viewer realtime disconnected | “Connection lost”; no stale online dot. Restore from the normal reconnect path. |
| UOA authority unavailable | “Availability can't be verified right now.” Show Unknown, wait/retry; do not claim revocation or green availability. |

“Install/help” opens official documentation; this feature does not execute an
installer. “Open Ollama” launches only a platform package-verified fixed target
after the click; if that identity cannot be established, show instructions
instead. A Linux CLI-only installation gets instructions rather than a generic
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
| Designer / computer selector, only when choices differ | Owner/editor | Pick which of the agent owner's consented computers processes prompts | Two own computers imply different uptime; V1 never lists another person's host | Owner-matched hosts plus unexpired server lease | The app would silently pick a computer |
| Designer / installed model selector | Editor | Choose model quality/capability from what is installed | Existing agent needs an explicit usable model | Host inventory names/digests/capabilities | The app would infer a model choice |
| Designer / incompatible reason beside a model | Editor | Choose a compatible model or edit tools | Prevents saving a choice that cannot run | Capability intersection and smoke result | Runtime fails after apparently valid setup |
| Designer / “Find Ollama on this computer” | Local desktop user | Permit local discovery once | Marks when native local observation begins | Native permission and server eligibility | Discovery would occur without local consent |
| Setup / bounded progress and Cancel | Person performing setup | Wait briefly or abandon setup | Discovery/test can take seconds | Native task state and hard deadline | A stopped app looks hung; Cancel must abort work and revoke pending preparation |
| Setup / native consent summary and Allow/Cancel | Owner/custodian | Authorise this canonical origin, org, agent and exact local model to process input | Server permission cannot consent for the computer | Opaque challenge fetched by main native window; canonical signed fields | Webview text could mint misleading consent |
| Designer / existing Save with confirmed test result | Owner/editor | Solely commit the exact inactive consented binding | Gives one unambiguous final activation decision | Prepared binding, policy/form/host revisions and transactional CAS | Confirmation could unexpectedly switch the lane |
| Setup / concise data-boundary and lifecycle sentence | Owner/editor and custodian | Decide whether local processing meets the need | Nessie still assembles prompts and deployment judges/memory may remain cloud | Static accurate contract for chosen transport | Person may believe this is offline/private-to-device chat |
| Designer / pending consent + Cancel request | Editor | Wait for custodian or choose another route | Remote consent cannot be assumed | Expiring prepared binding | A half-configured agent appears usable |
| Local host repair / alternate loopback port | Custodian, on failed discovery | Reach a non-default local Ollama install | Endpoint ownership belongs on the machine, not a remote editor | Native literal-loopback validator and canonical saved socket | Person must reconfigure a working installation |
| Local host repair / conflicting-daemon selector | Custodian, only when distinct loopback daemons answer | Bind the exact local daemon that may receive prompts | Response timing cannot safely choose an endpoint | Canonical literal sockets plus normalized reported identities | A hostile or accidental second daemon could win a race |
| Setup / Open Ollama | Custodian with package-verified install | Start their existing application after an explicit click | Fixes installed-but-stopped state without auto-launch | Platform package identity and fixed launch target | They must hunt for the app after setup fails |
| Setup / official install/update/setup link | Custodian, matching error | Install/update/configure Ollama themselves | Nessie does not modify the runtime automatically | Classified missing-response/version state | Error gives no actionable way forward |
| Setup / Retry repair | Custodian | Re-run the failed bounded probe/test | Confirms a deliberate local repair | Exact failed operation and native deadline | Person cannot tell whether repair worked |
| Designer / Refresh models | Owner/editor with current own host | Observe a newly installed or removed model now | Avoids waiting for the next inventory refresh | Bounded paginated inventory observation | Picker remains stale after a deliberate model change |
| Setup / “Use updated model” | Editor and custodian | Accept changed weights deliberately | Tag is mutable; consent is digest-bound | Old/new inventory digests, safe display name | Update silently changes the model or strands selection |
| Setup / active connection message | Custodian | Reuse an existing host or explicitly change mode | Prevents confusing duplicate connections | Local endpoint coordination plus entitled server host | Two bridges compete without explanation |
| Settings Connections / current connection row | Owner/custodian | Find and manage their active local hosting | Durable home outside one agent's form | Own host label, transport, lease and selected models | Local hosting is hard to discover after initial setup |
| Settings Connections / pause/resume | Custodian | Temporarily stop/resume accepting inference | Gives immediate control over local resources | Local pause and server acknowledgment | Only quitting/revoking could stop work |
| Settings Connections / Revoke server relationship | Custodian | Immediately fence this host and all bindings at Nessie | Server revocation must work even if the machine is offline | Current server host, authorization epoch and confirm shell | An offline computer remains authorized |
| Native host / Delete local key and state | Custodian | Remove this installation's protected key and cached receipts | Local deletion cannot claim server revocation | Local secure-store result and remaining server status | Sensitive local state survives uninstall/repair intent |
| Settings Connections / secure-storage repair | Direct desktop custodian with failure | Configure OS secure storage or retry | Required to make protected pairing durable | Native typed key-store error | User sees a generic failure or accepts insecure storage |
| Models settings / Local Ollama user-or-team target | Admin | Choose exactly whom to enable | Required administrative scope distinction | Existing live people/team selectors | Admin can only enable everybody or nobody |
| Models/settings reuse / enable value and lock | Admin | Grant permission and decide whether lower scopes may override | Implements user/team policy and precedence | `ScopedSetting` typed service | Scope selection would be cosmetic |
| Any policy control / inherited value and lock explanation | Affected viewer; editor only with live org-admin authority | Understand who can change the decision | Prevents impossible edits and support guesswork | `setAtScope`, `lockedAtScope`, plus separate server `canEdit` | UI offers an edit the service refuses |
| Members person detail / local enablement doorway | Admin | Enable the person where their access is managed | Required in-context discovery | Same scoped control, target person | Admin must discover an unrelated page |
| Team settings / same enablement doorway | Admin | Enable the team where team policy is managed | Same capability, correctly scoped | Same component, target team | Team enablement remains hidden |
| Agent avatar / online/offline/unknown badge | Reader in current addressing surfaces | Decide whether to expect a prompt response | User explicitly requested human-like availability | Server-derived availability, server time and TTL | Local agent looks always available or stale green |
| Conversation header / accessible state text and repair link | Reader; link only owner/editor | Wait, act elsewhere, or repair this agent | Colour alone does not explain unavailable work | Same availability projection; registry link to `designerSection=model` | Offline badge has no next step or accessible meaning |
| Conversation / run wait and Cancel | Run actor with existing permission | Stop waiting for this computer | A sent message must not disappear silently | Existing run lifecycle plus typed local reason | Offline work becomes an unbounded wait |
| Conversation / Restart after repair | Run actor with restart authority | Start a new run on the repaired exact selection | Terminal local failure otherwise strands work | New authorized run action; never replays accepted attempt | Person must resend/duplicate work manually |
| Alert bell / one repairable health alert | Exact owner/custodian or live policy admin for that failure | Return to the exact failed capability | Unattended failure needs a durable signal | Reader-first typed alert, resource authorization and health revision | A recurring agent can remain broken silently |
| Executor detail / reused Local Ollama section | Owner/custodian | Publish own model, inspect remedy or revoke hosting | The person may stand in the executor when configuring it | Same host facade/component; no invented host-admin role | Relay setup has no reachable owning surface |
| Executor menu/tray / Enable local hosting | Owner/custodian | Permit read-only discovery and make this installation eligible for the owner's bindings | Cloud admin cannot activate local access | Local hosting permission and server eligibility | No meaningful local permission boundary |
| Executor menu/tray / pending consent review | Owner/custodian | Allow or reject one exact agent/model challenge | Hosting permission is not per-agent consent | Canonical signed challenge fetched by native shell | Enabling hosting would imply blanket consent |
| Executor menu/tray / one status/remedy line | Custodian | See whether to start Ollama, reconnect or approve | Each failure has a distinct action | Same normalized host state | Local control says only “error” or falsely “online” |
| Executor menu/tray / pause/resume | Custodian | Stop/resume inference without stopping other executor work | Model hosting is separately consented | Shared local host lifecycle | User must disable unrelated capabilities |
| Executor menu/tray / open selected connection | Custodian | Reach the existing detailed configuration | Prevents a parallel native admin panel | Navigation deep link to exact host/executor | Native menu has to duplicate all controls |
| Executor CLI / `status` | Linux/headless custodian | Decide what needs repair and whether hosting is active | Headless operation has no tray line | Same normalized host state, canonical origin/account, machine-readable option | User would act blind |
| Executor CLI / `discover` | Linux/headless custodian | Explicitly permit and run read-only loopback detection | Discovery needs a local consent boundary | Same deterministic probe service | Detection would be implicit |
| Executor CLI / `enable` and `disable` | Linux/headless custodian | Start or stop accepting owner bindings | Hosting is distinct from one consent | Same local desired state and server acknowledgement | User must stop unrelated executor work |
| Executor CLI / `pending` | Linux/headless custodian | See which exact requests await a decision | Consent ids must be discoverable without a tray | Canonical bounded pending list | `consent` would require guessing an id |
| Executor CLI / `consent` and `reject` | Linux/headless custodian | Decide one displayed exact challenge | Server/editor cannot consent for the machine | Canonical challenge plus explicit confirmation | Requests cannot be safely answered |
| Executor CLI / `pause` and `resume` | Linux/headless custodian | Temporarily fence or resume inference | Immediate resource control must remain local | Shared host state machine | Only revoke/quit could stop work |
| Executor CLI / `revoke` and `forget-local` | Linux/headless custodian | Separately revoke server authority or delete protected local state | Either half can fail while offline | Separate idempotent results and remaining-action status | CLI would make a false all-or-nothing claim |
| Error only / expandable support details | Owner/custodian | Copy sanitized version/reason/request id for diagnosis | Repairs cases basic copy cannot resolve | Typed diagnostics, no paths/content/tokens/model output | Diagnosis would require raw logs |
| Browser-only setup / Desktop open/download and executor choice | Eligible user without native bridge | Move to a host-capable surface | Browser cannot reach local Ollama safely | Native capability detection and entitled hosts | Page offers a scan that can never work |

Do not add standalone presence pages, GPU/RAM meters, model leaderboards,
connection counters, token/cost chips in conversation, generic “advanced” debug
forms, heartbeats, raw ids, repeated transport badges, new sidebar sections or
an independent executor model manager. None enables a decision in this brief.
Diagnostic ids belong only in expandable failure details. Queue length is not
a prediction of latency and does not merit a normal-screen counter.

## Implemented doorway details

The live picker receives only fresh, local-only observations from the signed
host belonging to the effective person. It groups them as **This computer**;
the group is a choice of processing location, not a hardware or performance
dashboard. A local option carries the host and manifest internally so two
computers with the same tag cannot be silently conflated.

Connections renders **Prepare this computer** only in Nessie Desktop. It asks
the native shell to create the protected identity, registers its public half,
then starts the direct host so its bounded loopback observation can report a
verified model. It never starts Ollama. The interim copy is a real pending
state rather than a successful-looking offline registration. **Open paired executors** is the
browser's honest doorway to a host it cannot inspect. Each executor-backed row
also has **Open executor**, because the executor detail is where its pairing
and recovery controls live. Pause, resume, and revoke remain next to the
connection they affect; no heartbeat, socket, GPU, token, or raw-id telemetry
is rendered.

Selecting a local model on an existing agent renders one approval block. Its
only actions are **Approve local model**, the already-paired executor doorway
when applicable, and the existing final Save. Desktop receives just the opaque
challenge identifier and must fetch the canonical consent details before its
native confirmation; it never trusts browser display text. The executor path
shows its exact existing command only after the server created that one-use
challenge. “I approved it in the executor” merely enables Save; the server
still rejects Save unless that machine's signature has created the inactive
consent, so the acknowledgement cannot activate or bypass anything.

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
