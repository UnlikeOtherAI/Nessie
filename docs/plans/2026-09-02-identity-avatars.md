# One identity picture

**Status:** built, 2026-09-02.

Every avatar in the admin — a person, an agent, a project, a workspace, an app,
a search hit — is one component with one shape and one resolution chain.

## The defect

Six primitives and seventeen hand-rolled tiles drew identity pictures across
twelve distinct corner radii. Two of the disagreements were visible side by
side in a single screenshot:

- The **Personal Assistant** showed its portrait in the sidebar and a `⚡`
  placeholder in the thread panel one panel away.
- An **agent DM** was a flat purple letter in the sidebar and a
  palette-coloured portrait in the channel it opened.

Both had the same cause: the picture and the identity were resolved by
different reads. `GET /api/agents` deliberately omits `systemManaged` agents
unless asked for `?scope=all`, so the Personal Assistant was absent from the
`agentMap` every message row consults; and the sidebar's DM projection
(`SidebarAgentDm`) dropped `avatarAttachmentId` before a row could draw it.

Beyond those, a person and an agent in the same compose picker were a circle
and a rounded square; a message author's keyboard focus ring was
`rounded-full` for a person and `rounded-lg` for an agent one row above; and
the organization logo was previewed and cropped as a circle while rendering as
a rounded square everywhere it actually appeared.

## The shape is a function, not a class

`admin/src/components/primitives/identity-shape.ts`:

```ts
identityTileRadius(size) = max(3, round(size × 0.28))
```

A `rounded-*` class could not express this. The `--radius-sm|md|lg|xl` tokens
are re-declared on `:root` in `admin/src/styles.css`, so Tailwind's
`rounded-md` resolves to a flat **10px at every size** — which drew a 96px
agent portrait as a near-square and an 18px sidebar tile as a *full circle*,
from the same class name. (`styles.css` already documents this trap for card
radii; this is the same trap one level down.)

0.28 is chosen so the most-seen size does not move: a 36px message avatar keeps
exactly the 10px it had. Rings and focus outlines take `identityRingRadius`, so
they follow their tile instead of guessing.

## The components

| Layer | Owns |
|---|---|
| `primitives/IdentityTile.tsx` | the shape, the broken-image reset, the fallback |
| `UserAvatar` | UnlikeOtherAI relay → local attachment → provider URL → initials |
| `AgentAvatar` | the attachment, the palette colour, the role glyph |
| `ProjectAvatar` | the attachment, the emoji, the folder mark |
| `WorkspaceAvatar` | the membership relay → UOA's public image → initials |
| `AppIcon` | the Nessie-served icon path → initials |
| `shared/SearchResultMarker` | which search hits are identities and which are types |
| `features/channels/MessageAuthorAvatar` | who authored a message, and its focus ring |

A call site describes *what it depicts*; it never assembles a tile. The
broken-image reset used to be repeated in four primitives, each keyed on a
different dependency.

## An agent's picture resolves from its id

`admin/src/providers/AgentIdentityProvider.tsx` merges the agents list with the
Personal Assistant and answers `useAgentIdentity(agentId)`. `AgentAvatar`
upgrades whatever partial record a caller holds through it, so a surface that
knows only an id cannot fall through to the `⚡` placeholder.

It is deliberately **identity-only** — name, role, picture — and never a second
agent list. Pickers, bindings and policy surfaces still read `useAgents()`,
which still excludes system agents. Nothing here widens what a caller may *do*
with an agent, only what it may draw.

## One palette

`AGENT_AVATAR_BACKGROUND_COLORS` (`@nessie/schemas`) has exactly one importer.
`admin/src/lib/avatar.ts` keeps only `getInitials`: its `agentGradient` was a
second identity palette competing with that one, and its `dmGradients` /
`getDmStyle` had no reader at all.

## The native chrome

`mobile/` is the only non-admin client that draws avatars — the Tauri desktop
shell is a WebView over the admin, and the `macos/` voice companion has no
avatar fields in its models at all. Its native header disagreed with the
WebView an inch below it on both counts:

- **Shape**: the workspace mark was `size / 4` while the person beside it was
  `size / 2` — a circle. Both now use the shared contract, duplicated in
  `mobile/src/lib/identity-shape.ts` because the Expo app does not build
  against the admin bundle.
- **Source**: the bridge was handed `me.user.avatarUrl`, the *last* entry in
  the web's precedence chain, so anyone whose picture lives in UnlikeOtherAI or
  in a local upload saw initials natively and their face in the WebView. Those
  two better sources are authenticated byte endpoints held as `blob:` object
  URLs, which belong to the document alone and resolve to nothing in a React
  Native `<Image>`. The bytes now travel instead of the address:
  `admin/src/lib/native-shell-avatar.ts` re-reads the already-fetched blob as a
  `data:` URL. One resolution chain, no second auth path natively.

## What the tests assert

`admin/test/identity-avatar-consistency.test.ts` — the invariants, not class
names:

- the radius scales, stays strictly under a circle at every size, and is
  monotonic;
- initials cap at two letters and survive an astral first character;
- no module reintroduces a gradient tile or the dead DM palette;
- the agent palette has exactly one importer;
- the web and native shape contracts are identical;
- no native component derives a radius from `size / 2`.
