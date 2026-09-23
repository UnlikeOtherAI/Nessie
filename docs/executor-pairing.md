# Pair a machine with Nessie

Open **Nessie Executor** on the machine and choose **Pair with Nessie**.
Choose the folder it may work with. The app displays eight digits, a
fingerprint and the time remaining.

In Nessie, open **Agents → Executors → Pair executor** and enter those digits.
Choose the team and who may use the machine, then check its fingerprint and
press **Pair machine**. A project's **Executors** tab opens the same popup
with that project and its team selected.

Return to Nessie Executor on the machine. It names the organisation and team
that claimed the code. Confirm them to finish pairing and start the executor,
or decline if they are not the ones you intended. The website waits for this
confirmation; entering a code alone does not activate the machine.

The code lasts ten minutes and works once. Leading zeroes are part of the code.
If it expires, start again on the machine. Closing the website popup does not
confirm a pending attempt.

## Existing pairing

The native app identifies an existing connection by organisation and team and
offers to replace it or cancel. Replacement revokes the old executor using
the machine's existing key, so it does not leave another active executor
behind. Existing access and audit history stay with that old record.

The Windows tray checks for older Desktop and default command-line connections
before starting. If one exists, close it in the app that manages it first;
Desktop has a local forget control on its Executors page. Server-side
revocation is a separate operation; do not forget the key before arranging it.
The service does not copy a user's existing key into its own store.
The Mac app reuses a single existing state directory in place and asks you
to resolve multiple existing connections before pairing.

One machine connects to one selected team in this flow. Connecting the same
machine to several teams is deferred. The team name identifies the connection;
the chosen private, project or organisation scope still decides access.
Several agents can use the same executor. Each agent has its own access and
operation grants; granting a second agent does not replace the first, and
removing one agent's access does not remove another's. Manage these grants on
the executor's **Agents** tab. **Add agent** opens a picker, then a confirmation
that names the agent and the permissions it will receive. Private assignment
and the agent's operation grants change together; removing one agent leaves
other agents' access intact. Pairing itself grants no
agent access. The selected team limit does not limit the number of agents.

**SSO access-change blocker:** allowing an agent, changing private assignments
and activating a capability revision currently require the control plane's
fresh local-password verification. Disconnecting and deleting a machine do
not: they only take access away, so they need the same management right as
Pause and nothing more. UOA-only accounts cannot complete these
changes until a shared UOA-backed fresh-verification flow exists. The
many-agent model is supported, but those grants are not yet usable by SSO-only
accounts. An ordinary login or refreshed session is not a substitute for
proof that a fresh authentication factor was checked for this exact change.
The confirmation explains the missing verification support and does not ask
SSO-only users to invent a local password. A new login or refresh is not proof
of fresh authentication: UOA's currently published contract provides no
authentication-time or factor-assurance claim for a relying party.

## Manage a machine

The default **Agents** tab lists one row per agent in the shared table, with
server search, cursor pagination and the standard page-size picker. Rows state
stored grants and private assignment, never claim that every runtime condition
is currently satisfied.

**Permissions** shows the latest machine proposal in plain language. Only a
current proposal awaiting review contributes to the Executors menu badge and
the row's review link. Superseded versions and old draft reviews are history,
not work awaiting a decision. The permission review lists the same folders,
programs and local apps that the machine signed; hashes and protocol names
remain in the protocol and audit records.

**Activity** shows the 20 most recent sessions and links to their conversations
only when the viewer can open them. It has no per-session disconnect button:
disconnecting revokes the whole executor. The **Machine** menu owns
Pause/Resume, Disconnect, Delete, private-machine people, local models when
connected, and local Desktop controls when available. Drain stays an operator
API action; it is not a graceful finish-and-resume operation.

**Disconnect and Delete** are both confirmed lifecycle changes that anyone who
manages the machine can apply without a fresh identity check. Disconnect
(`revoke`) ends the pairing: work stops, the daemon's next connection is
refused, and the machine stays listed as Disconnected. Delete (`remove`) does
the same and also sets `removedAt`, which hides the executor from the list,
its detail page and every further change; it works from any state, including
a pairing that never completed. The row itself is kept, because run bindings,
leases and the audit trail point at it, and a removed executor is always
revoked, so every revoked-status guard still refuses its daemon. Either way
the machine can pair again: a new pairing mints a new machine key, and the
code-based replacement path retires the previous record by proof from its old
key.

## Platform operation

- **Windows:** the installed service starts at boot; the tray owns local
  pairing and confirmation. See [Windows desktop](running-the-apps/windows-desktop.md).
- **Mac:** the menu bar app starts an already-paired executor when launched.
  Its **Start at login** setting controls automatic launch. See the
  [menu bar guide](running-the-apps/executor-menu-bar-macos.md).
- **CLI:** interactive pairing displays the same eight digits and requires
  local confirmation. Native apps use the same packaged runtime through its
  JSON pairing commands.

Production Windows controls require a release with a pinned, verified Windows
publisher. A distributable Mac app requires its configured Developer ID
certificate and notarization. A missing certificate is a release blocker;
pairing does not weaken either verification gate.

## Protocol and verification

The [management element audit](testing/executor-detail.md) records why each
detail-page element remains, moves into a dialog, or is removed.

The [executor protocol](executor-protocol/overview.md#42-machine-first-pairing)
defines machine proof, expiry, atomic claims, replacement and local
confirmation. The code is a lookup value, never a machine credential.
UOA-bound organisation and team names are read from UOA; Nessie retains only
stable references for the connection.

`pnpm --filter @nessie/admin test:e2e:executor-pairing` runs the actual dialog
headlessly against controlled responses on this worktree's development ports.
It covers invalid and expired codes, leading zeroes, fingerprint confirmation,
waiting for the machine, refusal, successful completion, a fresh reopen, and
the project doorway on desktop and phone widths. Screenshots go to
`e2e/screenshots/executor-pairing/`. This browser fixture proves the client
flow; server tests independently cover cryptographic and transaction gates.
