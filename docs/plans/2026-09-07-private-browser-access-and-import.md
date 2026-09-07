# Private browser access and selected-site import

**Date:** 2026-09-07 · **Status:** temporary grant foundation and Chrome importer protocol in progress; no release claim.

This plan defines the private browser lane. It is separate from an agent's
ordinary shared Browserbase context and from the dormant connected-Chrome tab
feature. A person can make their own selected website sessions available to a
private agent browser without giving Nessie a password, a browser profile, or
a general Chrome-reading capability.

## Decisions

- A persistent private browser belongs to exactly one person and one agent.
  Its context is a personal Browserbase connection's context, never a team or
  organisation context. There is no team inheritance.
- A temporary private grant is scoped immutably to one person, agent, thread,
  selected HTTPS origins, and an expiry of at most fifteen minutes, bounded
  further by the deployment's hard browser session TTL. The parked run id
  changes once, atomically with card resolution, to its exact continuation;
  that preserves one task's consent without granting a different run access.
  Activation opens a fresh Browserbase session with no persistent context and
  navigates only to the first approved origin, even for a newly connected
  account. It never copies or writes back cookies. If a response is interrupted
  after that exact session is linked, a retry while the original card is still
  waiting returns that live unadopted session; it never creates a second one.
- The worker validates the active grant, current private-home membership,
  current explicit browser verb grants, and the actual current origin before
  every read or action. Human identity-provider redirects stay private; they
  never widen the agent's origin list. A grant prevents tab capture and a
  revoked or expired grant cannot fall back to a durable jar in that run.
- Cancellation, terminal handling, and expiry revoke the grant locally before
  attempting provider release. An uncertain provider stop remains unavailable
  to reuse until the tracked lifecycle confirms closure.
- This foundation admits temporary personal browser state only for an owner's
  private agent home or a system-managed agent's exact personal home. Shared
  and team-agent conversations are refused; they never receive personal
  cookies, browser observations, or credential-derived output.
- Human keyboard and pointer control follows the same private-home authority.
  An unsigned team browser may remain observable for ordinary automation, but
  nobody can take its controls and create a personal sign-in there.
- A legacy shared team browser with any human login is quarantined. It cannot
  be opened, adopted, observed, acted in, downloaded from, or used as a
  disclosure source until reset, even by its signer or a prior requester.
  Those people may see only recovery metadata and reset it. Unsigned shared
  automation remains available; a future team-service credential needs its
  own explicit authority model.
- Long-lived created API keys are distinct from browser sessions. If a service
  displays one, the agent must pause and post the existing personal
  `vault_secret` card; the person copies it directly into that masked form and
  the resumed run receives only the opaque reference. Ending or revoking the
  browser grant never revokes a key the service issued; that key has its own
  service-side lifetime and separate revoke path.
- Human browser view and input remain mediated by Nessie, not provider live
  view URLs. This is what lets Nessie enforce the controller lease, private
  observations, and mobile keyboard input. A team may watch unsigned public
  browsing, but only a person's exact private agent home can claim controls;
  shared browsers never accept human input or sign-in.
- A Browserbase disconnect is a reversible local disable: Nessie deletes the
  encrypted key in the same transaction and marks its connection disabled,
  while retaining durable context rows and Browserbase-side sign-ins. It
  refuses while a session is live, unknown, allocating, releasing, or a
  context is tombstoned/deleting, because that resource still needs the key
  for confirmed closure. Reconnect supplies a new key and may reopen the
  retained context only when Browserbase accepts that account; Nessie never
  copies a context or silently clears its sign-ins. Connection replacement,
  durable-context creation, and reset serialize on the connection then the
  browser row, so an old key cannot create a context after disconnect/rekey.
  A failed inline cleanup of an untracked, newly-created empty context is
  logged for Browserbase-dashboard recovery; no human login or run session has
  been attached at that point.
- A fresh private session stores its own selected viewport. The launch card
  chooses the current phone, tablet, or laptop preset, and a current private
  controller may resize only that session; its canvas applies the change on
  the existing CDP target so screenshots and pointer coordinates agree. Frame
  metadata reports that emulation size, not a scrollbar-reduced page layout.
- Browser Home resolves the configured HTTPS address on the server, but only
  the current authenticated canvas sends the resulting navigation. The same
  canvas lease and target checks therefore govern Home, address entry, and
  every other human navigation; HTTP routes never attach CDP to steer a page.
- Start leaves an incompatible reply or dashboard route for the existing
  Browser screen while retaining the card's exact thread as a structural query
  parameter. The owner then presses the visible Take control control. Nessie
  never auto-claims after Done: the adopted successor remains with the agent.
- The model may request this lane only through the real
  `browser_login_request` tool. It supplies selected HTTPS origins as structured
  arguments. A generic `card_post` card or chat text cannot grant access or
  imitate that request; if the tool is unavailable, the model directs the
  owner to explicitly enable the required browser tools in Agents → Tools.

## Production rollout preflight

Before deploying `20260909110000_browser_unknown_session_guard`, an operator
runs this read-only aggregate against the production Postgres database. The
prior partial unique indexes excluded `unknown`, so a failed remote stop could
have left an old unknown row beside a later live row for the same run or
persistent browser.

```sql
WITH blocking AS (
  SELECT id, run_id, agent_browser_id, status
  FROM cloud_browser_sessions
  WHERE status IN ('allocating', 'active', 'releasing', 'unknown')
)
SELECT 'run' AS collision_kind, run_id AS subject_id, array_agg(id) AS session_ids
FROM blocking
WHERE run_id IS NOT NULL
GROUP BY run_id
HAVING count(*) > 1
UNION ALL
SELECT 'agent_browser', agent_browser_id, array_agg(id)
FROM blocking
WHERE agent_browser_id IS NOT NULL
GROUP BY agent_browser_id
HAVING count(*) > 1;
```

An empty result permits the migration. Any result blocks rollout: do not mark
an `unknown` session released from the database. Confirm each provider session
is terminal, then use the tracked release/reconciliation path to record that
outcome and rerun the preflight. The migration is transactional on Postgres,
but a failed `prisma migrate deploy` still parks later deploys until the
failure is explicitly resolved under the deployment runbook.

## Chrome selected-site import

Chrome is the first source platform. The MV3 extension asks at runtime for
the `cookies` permission and an exact HTTPS host permission only after a
person checks one or more sites in the import popup. It reads cookies only
while those selected-host permissions are live, filters them to cookies Chrome
would send to each exact selected host at every cookie path, and drops the
permissions after the handoff. It does not read Chrome profile files, Keychain,
passwords, history, Sync, storage, or a bulk profile. It does not run a
content script.

This is the Chrome permission model, not an assumed browser capability:
[Chrome's permissions documentation](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
requires the API and matching host permission for `chrome.cookies`, and
supports optional API and host permissions granted at runtime. The native
bridge follows [Chrome's native messaging requirements](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging):
an installer registers a manifest with one fixed host path and non-wildcard
extension origins, and Chrome uses length-prefixed JSON over stdio.

The optional permissions are dropped after the handoff. Refresh is another
explicit import request. Revoking the imported browser state is an explicit
Nessie action that resets the private browser context; there is no background
cookie synchronization. Partitioned cookies are refused in this phase rather
than guessed at, and the surface names manual sign-in as the fallback. Some
sites bind cookies to a device or demand a new login; a successful import is
therefore not a claim that the destination will authenticate.

Source domain cookies can apply to a selected host, but their source scope is
never preserved: the importer writes a new host-only CDP cookie at that chosen
host and exact path, omitting the domain attribute. It therefore cannot give a
sibling host the same login. A cookie whose domain does not apply to the chosen
host, an unsafe path, or a partition key is refused. Login flows often depend
on a distinct identity host; the person must select that host as another site
or sign in manually. Nessie never expands the selection automatically.

The extension popup shows the destination person, agent, selected sites, and
retention before it asks Chrome for anything. Cookie values never render in
the popup. The extension passes the selected cookie payload only in memory to
the release-pinned native host; it never sends it to an LLM, tool result,
executor command receipt, transcript, browser observation, or log.

The host is launched only by a signed installer registration whose Chrome
native-host manifest pins the release extension id and an owner-only launcher.
The launcher supplies the fixed paired state directory and the caller origin
to `nessie-executor native-browser-cookie-import`; the CLI verifies that
origin before it reads protected paired state. It uses the exact paired API
base URL and the executor's Ed25519 identity plus current connection epoch.
It cannot accept a destination URL or target from a page or model.

The dedicated protocol is deliberately outside generic executor commands:

1. An authenticated Nessie surface creates a short-lived pending request for
   one private actor/agent, exact paired executor, and exact HTTPS origins.
2. The native host polls the paired API with a signed
   `browser_cookie_import.poll` request. It receives only the request id and
   consent display metadata. The database holds no cookies.
3. After the person checks sites and Chrome grants the exact optional
   permission, the host uploads `{ executorId, connectionEpoch, requestId,
   selectedOrigins, submittedAt, cookies, payloadDigest, signature }` to its
   dedicated endpoint. The signature covers the canonical full payload. The
   service conditionally claims `pending → importing` before contacting the
   provider and never returns cookie fields in success or error bodies.
4. The service rechecks current private ownership, live membership, the
   paired executor, the selected-origin subset, and the personal Browserbase
   connection and private-home thread binding. It records conservative
   selected-origin login provenance before tracked session admission, imports
   through that lifecycle into the person's per-agent `AgentBrowser` context,
   and never falls back to an organisation connection. It marks imported only
   after Browserbase confirms the session reached a terminal state; an
   unconfirmed stop remains quarantined as `unknown`.

An ambiguous provider outcome is not blindly retried. A retry begins a new
user-authorized request after checking the destination state. Cancellation,
expiry, and failure are visible request states with a named remedy.

## Platform truth

The signed native-to-API-to-Browserbase path has passed with synthetic cookies:
the native bridge signed the paired API upload and the tracked Browserbase
import reached its confirmed-release outcome. That result does not verify
Chrome's operating-system native-host registration. The isolated-profile check
could not install or validate that registration, and this Mac has no
`Developer ID Application` identity for a release launcher.

Chrome on macOS therefore has reviewable source and packaging artifacts, but
not an installed extension release. It still needs a Chrome Web Store publisher
and stable extension id, a Developer ID Application-signed launcher, and an
installer-owned native-host registration before it can be called usable.
Windows is unavailable: its required service IPC bridge and installer path have
not been implemented.

Before that release can be made, Nessie needs a Chrome Web Store publisher and
the resulting stable extension id, a release-signed native-host launcher, and
platform registration that points Chrome only at that launcher. Windows also
needs an authenticated service bridge: its paired executor state is owned by
the executor service and an interactive Chrome child must not read it directly.
There is no existing release id, store listing, registration, or such bridge in
this repository, so an online executor alone is not evidence that the Chrome
helper is ready.

The reviewable macOS packaging seam is `executor/scripts/prepare-chrome-cookie-import.mjs`. Development emits an isolated unpacked extension identity, fixed local launcher, and unregistered native-host manifest. Release accepts only a Chrome Web Store id and a Developer ID-verified launcher, then emits artifacts for the signed installer; it neither signs nor registers them. The operator steps and readiness boundary are in [the macOS import guide](../running-the-apps/chrome-cookie-import-macos.md).

Safari is a viable research path, not an unavailable-by-design platform.
Apple documents both [Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
and [messaging between a containing app and extension JavaScript](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension).
Nessie has not implemented or verified Safari cookie access, the containing-app
transport, or the required signing and entitlement behavior. Safari is
therefore unavailable until that work proves the exact scope and release path;
it is not declared impossible.

## Verification map

The deterministic mediated Browser Cloud usability runner now runs in the
required Navigation Transitions CI job. It uses the job's managed API, admin,
Postgres, and Chromium lifecycle, exercises the explicit browser grant and
cross-client revocation doorways, and uploads its narrow and fullscreen
screenshots as a CI artifact. It uses a provider-shaped fixture, so it proves
the Nessie surface without requiring a Browserbase credential in CI.

The final database-backed Turbo run passed all 37 selected tasks: Browser
Cloud (87), Executor (169; two environment skips), Worker (1,191), Admin
(1,434), and API (1,621; four pristine-database skips). It covers a new
personal connection with no durable jar; activation/cancellation races; exact
origin and verb checks; owner-only view and control; successor adoption; no
fallback after revocation; session release/unknown handling; import ownership;
and no cookie value in durable outputs.

A real Browserbase handoff also passed on the corrected UI. From the reply,
**Start private** opened the existing Browser screen with the exact thread
parameter, the owner explicitly took control, and the throwaway session was
empty despite existing durable cookies. Real touch scrolling and typing with
spaces completed the sign-in. **Done** returned 204 without an automatic
control request; the agent then read the public heading “Herman Melville -
Moby-Dick”, closed its browser, and its exact successor completed. The tracked
session released without an error.

The durable context was then reopened through the UI after the task closed.
Its cookie page contained both the signed-native selected-site import marker
and the pre-existing durable-context marker, but never the temporary task's
cookie. A generic **Done** returned 204 and released that persistent session
without creating the requested task. This proves the temporary no-context
session did not copy cookies back into the saved private context.

The final mobile viewport retest also passed. A durable saved browser moved
from laptop to phone dimensions through live WebSocket frames, remounted with
“Your controls are paused”, and accepted touch scrolling at 390×844. On the
form page, the first tap focused the browser keyboard and subsequent real
input preserved “Nessie mobile QA” including spaces. **Done** showed Saving,
closed the panel, and reached confirmed release.

This is not a Chrome import release claim. Chrome-on-macOS native-host
registration and release packaging remain unverified, as do the Chrome Web
Store identity and signed launcher prerequisites described above.
