# Executor menu bar app for macOS

A person downloads an installer from the website, opens it, and from then on
the executor is a small icon in the macOS status bar. From that icon they can
open settings, see **where it can reach**, and see **which command-line tools it
may run** — and change all three.

The headless CLI stays exactly as capable. It is not a lesser path: the two are
clients of one authority, never two stores.

## Rule zero

The capability this delivers is reachable from the status bar icon on a Mac
where nothing else is installed. If a person has to run a terminal command to
reach any of the three surfaces above, this work is unfinished.

## One authority, two clients

The daemon's local policy in `<state-dir>/executor-state.json` is the only
durable record of what an executor may reach and run. It is already the thing
the signed descriptor digests (`localPolicyDigest`) and the thing an entitled
human reviews in Nessie before it takes effect.

- **`nessie-executor configure …`** is the one writer. Headless machines call it
  directly; there is nothing a GUI can set that a CLI cannot.
- **The menu bar app is a client of that CLI**, not a second writer. It renders
  the state and shells out to the bundled `nessie-executor` for every mutation.
  It never edits `executor-state.json` itself, so a local policy can never mean
  one thing to the app and another to the daemon.

This is the same rule the product already applies to identity: a second copy of
an authority's data is a defect, not a convenience.

## The allowlist is part of the reviewed policy

`command.run` today accepts any `program` the control plane sends, confined by
the guest micro-VM rather than by a list. The app's "tools it can run" panel is
only meaningful if the list is enforced, so the list joins the local policy:

- `commandAllowlist: string[]` — bare program names, matching the existing
  `program` grammar (no `/`, resolved through the fixed guest PATH, shells
  already refused).
- It is hashed into `localPolicyDigest`, so adding a tool bumps the policy
  revision and lands as `pending_review` in Nessie exactly like enabling an
  operation does. Nobody widens what a machine may run without a human seeing
  it.
- The daemon refuses a `command.run` whose program is not on the list with
  `EXECUTOR_COMMAND_DENIED`, before any guest starts.
- An empty list with `command.run` enabled is refused at configure time: an
  operation that can never succeed is a misconfiguration, not a policy.

## Where it can reach

The reach panel shows the two things that are already facts of the local state,
and lets a person change them through the same CLI:

- the canonical read-only **workspace root** chosen at pairing
  (`configure --workspace`), and
- the **allowed origins** the guest browser may open
  (`configure-browser --allowed-origins`).

Both are already owner-verified and both already refuse to change while drafts
or sandboxes exist. The panel states that refusal rather than working around it.

## The app

A native Mac app — SwiftUI/AppKit, `NSStatusItem`, no web shell.

- **Status item**: one icon whose state is the daemon's (stopped, running,
  attention). The menu carries start/stop, the three panels, and a Quit that
  says what it does to the daemon.
- **Settings**: pairing (API origin, enrollment, the fingerprint a person
  confirms in Nessie), workspace selection through a native picker, and
  launch-at-login via `SMAppService`.
- **Supervision**: the app spawns `nessie-executor serve --parent-liveness-stdin`
  and holds the pipe, so the daemon cannot outlive the app — the same contract
  Nessie Desktop already uses on macOS.

## Installer

A Developer ID signed, notarized, stapled DMG, built in CI from the same
prepared runtime (`executor/scripts/prepare-runtime.mjs`) the Linux package and
the desktop bundle use. Credentials come from CI secrets; a build without them
produces a clearly-labelled unsigned artifact that is never published.

## Verification

- Unit coverage for the allowlist decision and the configure-time refusals.
- A daemon-level proof that a program off the list never reaches a guest.
- The macOS app driven on this Mac: install from the built DMG, pair, run a
  permitted tool, watch a non-permitted one refuse.
