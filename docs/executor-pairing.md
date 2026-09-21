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
Desktop has revoke and forget controls on its Executors page. The service does
not copy a user's existing key into its own store.
The Mac app reuses a single existing state directory in place and asks you
to resolve multiple existing connections before pairing.

One machine connects to one selected team in this flow. Connecting the same
machine to several teams is deferred. The team name identifies the connection;
the chosen private, project or organisation scope still decides access.
Agents need their own grants for the operations they may perform.

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
