# Pair a machine with Nessie

Platform instructions: [macOS](running-the-apps/executor-menu-bar-macos.md#pairing-and-unpairing),
[Windows](running-the-apps/windows-desktop.md#pairing-and-unpairing), and
[Linux](running-the-apps/linux-desktop.md#pairing-and-unpairing).

## Before pairing

Install the executor on the computer that will run the work. For production,
choose **Nessie**, which connects to `https://api.nessie.works`, and sign in at
[Nessie](https://app.nessie.works). A development build can also offer a local
server: select production explicitly when that is the intended destination.
Keep executor state outside a repository or worktree; it contains the machine's
private key and must stay owned by the account that runs the executor.

Pair as the person whose OS account owns the programs. Pairing uses the current
team and starts with personal access; share it afterwards from Permissions.
API clients must use `/api/executor-pairing/options` for the selectable team
IDs; these are UOA team identifiers, not Nessie's internal team-row IDs.

## Find your machines from the account menu

The user menu has **Executors** for personal machines and **Team executors**
for shared machines you may see. Green means all are online, orange means some
are unavailable, and red means none are online. Click the label to open
**Agents → Executors**, or its arrow to expand the machines. Each machine opens
its own detail page. The list opens into the available space, including from
the top-right account menu on an iPad.

An empty group has a gray indicator and a direct **Add Personal Executor** or
**Add Team Executor** action, with no submenu. These open the same pairing
flow in the current team. Pairing starts personal; use Permissions to share it.

Presence arrives over the signed-in tab's shared WebSocket and updates the
menu, inventory and machine detail together. A missed heartbeat expires after
60 seconds; a background sweep announces the change within the next ten
seconds. Reconnecting the browser re-reads the current authorized inventory.
Online describes the machine connection, not permission for an agent to act.

## Complete both halves

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

Verify that the machine says **Paired**, names the intended organisation and
team, and appears **Online** in Nessie's Executors list. Online proves a daemon
connection; it does not assign an agent. Add agents in **Agents** and share the
machine with people, projects or the whole team in **Permissions**. Both changes
take effect directly. Install and sign in to Claude or kimix separately as the
same OS user.

For live output, open **Executors → Sessions**, or an executor's **Sessions**
tab. Agents return the same session link. **Share session** gives named users
in your organisation view-only access to that session, including scrollback;
the URL alone grants nothing. Remove a viewer in the same dialog to revoke it.

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

Each connection belongs to the current team. **Add agent** and **Remove** apply
immediately, without permission review or another identity check. Signed machine
capabilities become active automatically. The owner shares access through people,
projects and the whole-team switch; see [executor sharing](standards/executor-sharing.md).

## Manage a machine

The default **Agents** tab lists one row per agent in the shared table, with
server search, cursor pagination and the standard page-size picker. Rows state
stored grants and private assignment, never claim that every runtime condition
is currently satisfied.

**Permissions** lists people (Can use or Admin), projects (Can use), and the
Everyone in this team switch. Sharing with a project or the whole team also
makes the machine manageable by the team's administrators. **Sessions** retains
terminal views and local-app coding sessions.

**Activity** shows the 20 most recent sessions and links to their conversations
only when the viewer can open them. It has no per-session disconnect button:
disconnecting revokes the whole executor. The **Machine** menu owns
Pause/Resume, Disconnect, Delete, local models when
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

Stopping the local program, pausing a machine, disconnecting it, deleting its
server record and uninstalling the program are different operations:

| Action | Result | Use again |
| --- | --- | --- |
| Stop local daemon / quit owning app | Local connection stops; pairing remains | Start the same daemon/app |
| Pause in Nessie | Server stops accepting work under the paused executor | Resume after reviewing its state |
| Disconnect in Nessie | Pairing is revoked; work stops; history remains visible | Pair again with a new key |
| Delete in Nessie | Revokes and hides the record; audit references remain | Pair again |
| Uninstall | Removes local software; does not itself revoke server access | Reinstall and inspect retained state |

To unpair completely, **Disconnect** or **Delete** in Nessie first, then stop
the platform's local supervisor and disable its startup entry. Only remove
private state after revocation and after preserving any outputs you need.
Deleting a local key first can strand a server record and prevents the signed
replacement flow from proving ownership of the old connection. Unpairing is
not a way to preserve running terminal sessions.

If a code is expired or claimed for the wrong destination, cancel on the
machine and request another. If a paired machine is offline, check its local
process/service and logs, API connectivity, runtime integrity and the machine's
server status before replacing the pairing. A descriptor rejected with an
unknown capability or enum usually means the server and installed executor
versions differ; deploy compatible versions, then restart the supervisor.
Do not edit signed manifests, weaken key permissions or create another pairing
to conceal a runtime verification failure.

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
