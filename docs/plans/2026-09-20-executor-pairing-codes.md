# Executor pairing codes

**Status:** proposed, not built
**Replaces:** the copied `nessie-executor pair …` command in **Agents → Executors**

## Why

Pairing a machine today means copying a 400-character command out of a web page,
editing a placeholder inside it by hand, and running it in the right shell on
the right platform. The page that offers it has to carry three paragraphs of
caveats and a different story per operating system, because the command *is* the
protocol: it names an API base URL, a state directory, an enrollment id and a
256-bit challenge, and a person has to get all four right.

Everything in that sentence is the machine's business, not a person's. The
person has exactly one thing to say: **this machine is mine**.

So: the executor asks for a code, shows eight characters, and a person types
them into Nessie. Nothing is copied, nothing is hand-edited, and the flow is the
same on every platform.

## What changes about the protocol

`docs/executor-protocol/overview.md` §4.2 is **human-first**: a person creates
the executor with its immutable scope, the server mints an enrollment against
that executor, and the machine attaches to it. The executor row — organisation,
scope, project — exists before the machine has said anything.

This inverts that. The machine registers itself first, and the organisation and
scope are decided at the moment a person claims it.

| | today | with codes |
| --- | --- | --- |
| First actor | a person, in Nessie | the machine |
| When scope is chosen | before the machine is involved | when a person claims the code |
| What the person handles | enrollment id + 256-bit challenge, in a shell | eight characters, in a text field |
| What proves the machine | possession of the key it registered | unchanged |
| What the person confirms | the fingerprint | the fingerprint |
| What the machine confirms | nothing | the organisation and team it just joined |

The parts that do **not** change are the parts that carry the security: the
Ed25519 machine key is still generated on the machine and never leaves it, the
server still stores only the public key and fingerprint, the daemon still proves
possession before it is online, and a person still confirms a fingerprint.

## The flow

1. **The machine enters pairing mode.** Tray, menu bar app or CLI — one control,
   the same on each. It generates its Ed25519 key, stores it in owner-only state
   exactly as §4.2 step 3 requires, and asks the server for a code, submitting
   its public key, fingerprint and platform facts.
2. **The server mints a pairing code**: eight characters, single use, ten
   minutes, bound to that public key. It creates no executor and belongs to no
   organisation yet — it is an unclaimed machine, nothing more.
3. **The machine displays the code** and polls. The code is shown as eight
   boxes with a countdown, because a person is about to read it off one screen
   and type it into another.
4. **A person claims it in Nessie.** They are signed in, so the organisation is
   known; they choose the team and the scope, and see the machine's fingerprint
   and platform before they commit.
5. **The claim creates the executor** with the chosen scope, binds the already
   registered public key, and marks the code used.
6. **The machine's poll returns**, naming the organisation and team in words.
   The machine shows them and asks the person at the machine to confirm. Only
   then does it finish and come online.

Step 6 is not decoration — see the threat below.

## Why eight characters and not a 256-bit challenge

A code a person retypes cannot be 256 bits, so this is a real reduction and has
to be paid for elsewhere.

What makes it affordable is that **the code is not a credential**. It grants the
holder nothing: the machine has already registered its public key, and it
authenticates by proving possession of that key, not by presenting the code. A
stolen code cannot impersonate a machine, cannot read anything, and cannot
produce a paired executor for an attacker's own hardware.

What a stolen code *can* do is claim somebody else's machine into the thief's
organisation. That is the whole exposure, and it is what step 6 exists for: the
machine names the organisation and team it is about to join, to the person
standing at it. A machine that reports an organisation the person has never
heard of is a refused pairing, not a completed one.

The remaining controls:

- **Single use**, consumed under the same advisory lock §4.2 already uses.
- **Ten minutes**, the same expiry as the enrollment it replaces.
- **Rate limited on both ends** — minting per source, claiming per account —
  with the code locked after a small number of wrong attempts, so the space that
  matters is "guesses before lockout", not the size of the code.
- **Unambiguous alphabet.** Excluding `0`/`O` and `1`/`I`/`l` removes the
  transcription errors that would otherwise be indistinguishable from guesses
  and spend the lockout budget.

The choice of alphabet is the one open decision. Eight digits is 10^8; eight
characters from a 32-symbol unambiguous alphabet is 32^8 ≈ 1.1 × 10^12, four
orders of magnitude more room for the same typing effort. This document assumes
the larger alphabet; the flow is identical either way.

`overview.md` §11 lists "stolen pairing link or key replay" against
"short-lived single-use verifier, proof of possession, human fingerprint
confirmation". That row needs a fourth control — **machine-side confirmation of
the claiming organisation** — and gets it in the same change.

## Already paired

The reason this machine accumulated four pairings in one afternoon is that
nothing ever said it already had one.

Entering pairing mode checks local state first. If the machine is already
paired, it says so in the terms the person cares about — *"This machine is
already paired to Acme, in the Platform team"* — and offers to replace that
pairing or cancel. Replacing retires the old executor server-side rather than
abandoning it, which is what left orphaned rows behind before.

## Saying it in words

The current surfaces show a person the plumbing and hide the fact they want.
None of these may appear in anything a person reads:

- **"API"**, and any base URL standing in for the name of a Nessie.
- **State directory paths**, enrollment ids, challenges, `--flags`.
- **A fingerprint with no subject** — a fingerprint is only meaningful beside
  the organisation and team it is being confirmed against.

What replaces them: the organisation, the team, the machine's own name, and the
workspace folder chosen in a picker.

## Scope, and teams

A claim chooses scope from what exists today — `private`, `project` or
`organization` (`ExecutorScopeKind`). The claim UI names them in words rather
than as enum values.

**Several teams on one executor is deliberately not in this change.** An
executor is one `organizationId` plus an optional `projectId`; there is no team
scope at all, so "these two teams but not the third" is not representable. Adding
it is a many-to-many plus a third answer for every authorization path that
currently asks org-or-project — and it lands inside the
`Organisation → Project → Team` inversion that `docs/standards/team-model.md`
describes as still in its expand phase. Doing it now means picking a side in
that migration, so it waits until the inversion has landed.

Teams are UOA's, 1:1. The team picker lists them through the UOA API; it never
reads a local copy of the organisation structure.

## What gets built

| Piece | Where |
| --- | --- |
| `ExecutorPairingCode` — code hash, public key, fingerprint, platform facts, expiry, attempt count, claimed executor | `api/prisma/schema.prisma` |
| Mint, poll and claim routes, rate limited | `api/src/routes/executors.ts` |
| Claim dialog: code entry, fingerprint, scope and team | `admin/` |
| Pairing mode, code display, organisation confirmation | `executor/tray-windows`, `executor/menubar-macos`, `executor/src` CLI |
| §4.2 rewritten, §11 gaining the fourth control | `docs/executor-protocol/overview.md` |

The copied-command page goes away once the code path works on all three
surfaces; until then both exist, because a half-migrated pairing page is worse
than either.

## Open

- **Alphabet**: eight digits as originally asked, or eight unambiguous
  characters. Assumed here: characters.
- **Retiring a replaced pairing**: whether replacing revokes the old executor
  immediately or leaves it for the person to remove.
