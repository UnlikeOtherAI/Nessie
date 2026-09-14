# Marketing site rebuild — handover

## Where it is

- **Branch:** `work3`, pushed to `origin`. No pull request yet.
- **Worktree used:** `.claude/worktrees/slack-website-replica-26fbb9`.
- **Package:** `web/` (`@nessie/web`), the public site served at nessie.works.
- **Replaces:** the old landing, which opened on `SignInSurface` from
  `packages/sign-in-surface`. The new homepage links to the same SSO launch URL
  (`https://app.nessie.works/login?launch=sso`) from its buttons instead.

## Positioning

The whole site makes one argument; keep every change consistent with it.

- Nessie's agents are **real employees, not bots**: a name, an owner, their own
  email address, a seat in channels and DMs.
- **Agents work with each other** — handoffs, questions, results in the thread.
- A team can **grow far beyond its headcount**, while its people move to what AI
  can't do: **customer relationships and creative work**.
- **Nobody loses their job.**

Copy the owner rejected: "Grow your team. Then make it massive." ("massive"
sounds idiotic). Current hero title: "Grow your team. Keep your people."

Product backing for the claims: [agent email](../agent-email.md) and
[agent communication](../agent-communication-spec.md). Claims still to confirm
with the owner before launch: hiring an agent "in minutes", "24/7" work.

## Rules this work followed

- **No copying Slack.** Slack's homepage was used only for section order and
  component types (tabbed hero, dark band, carousel, sticky section index,
  story cards, stats band, promos, dark CTA). No Slack text, images, logos,
  CSS or code — do not reintroduce any, even "to tweak later".
- **Never name or disparage Slack on the page.** Contrast positively ("Not
  bots. Real teammates."). The meta description's neutral "European Slack
  alternative" is the only mention.
- **No invented proof.** Customer logos, quotes, stories, ratings and
  unmeasured stats render as dashed-outline `.n-placeholder` blocks. The
  "Trusted by" logo row was removed at the owner's request.

## Design decisions (owner-approved)

- **Colours:** top bar and dark sections navy `#0b172a` (`--n-ink`); secondary
  dark `#232646` (`--n-deep`, channels-menu colour) for the mobile menu, agent
  cards and stats band; blue `#0266fa` primary. Illustration tiles use the logo
  colours (green, blue, yellow, pink).
- **Logo:** multicolour N mark hand-traced from the owner's image into
  `web/public/nessie-mark.svg`. Replace with the original file if one exists.
- **Waves:** only on the **bottom edge of dark areas** (header, agents band,
  stats band, closing CTA). Flat for the first third, then two layers (0.45
  opacity back wave, solid front). A dark section's top edge is straight.
  The header's hanging wave breaks on the **left**; section waves on the right.
- **Hero:** lots of space above the headline (`clamp(112px, 13vw, 176px)`).
- **Secondary CTA:** "Open source" with the Font Awesome GitHub icon, linking
  to the repository. "Book a demo" was removed; nothing replaces it yet.
- **Cookie bar:** Accept all / Reject non-essential / Preferences (analytics
  toggle), stored in `localStorage` under `nessie-cookie-consent`, reopened
  from the footer's "Cookie preferences".

## File map

| File | Holds |
|---|---|
| `web/src/home/content.ts` | Every word on the page; edit copy here only |
| `web/src/App.tsx` | Section order and where waves sit |
| `web/src/home/header.tsx` | Sticky navy header and cookie bar |
| `web/src/home/hero.tsx` | Headline, CTAs, auto-advancing screenshot tabs |
| `web/src/home/blocks.tsx` | Agents band, what's new carousel, pillars |
| `web/src/home/closing.tsx` | Stories, stats, benefits, promos, CTA, footer |
| `web/src/home/wave.tsx` | `Wave` divider and `HangingWave` |
| `web/src/home/ui.tsx` | `Button` (optional icon) and cookie event name |
| `web/src/styles.css` | All styles, `n-` prefix, tokens at the top |

## Running and verifying

- Dev server: `.claude/launch.json` entry `nessie-web`, port **5471**
  (`vite --strictPort`). Not 5454/5455 — those belong to the API and admin.
- Install without a TTY: `CI=true pnpm install --filter @nessie/web...`.
- Gates: `pnpm --filter @nessie/web typecheck` and `lint` (both pass).
- The Claude Browser pane does not repaint after scripted scrolling, so lower
  sections screenshot blank. Verify with headless Playwright instead:
  `playwright-core` installed in a scratch folder, launched with
  `executablePath` pointing at the cached
  `~/Library/Caches/ms-playwright/chromium-1234/.../Google Chrome for Testing`
  (the bundled revision is not downloaded). Seed `nessie-cookie-consent` in
  `localStorage` to hide the cookie bar; force `.n-header{position:static}`
  for element clips.

## Open work

1. **Screenshots don't match the message.** All three show one assistant in a
   channel. Capture agent email and agent-to-agent handoffs; the hero tabs and
   pillar rows reuse the same three images.
2. **Placeholders:** stats in the AI employees and Your people sections, two
   quotes, four customer stories, the rating line.
3. **Dead links:** most footer links, "Cookie policy", "Privacy", "Terms" and
   the pillar CTAs point at `#top` or the repository.
4. **Mobile** was checked only for the header, menu and hero; review the rest
   at 390px.
5. **Landing flow:** confirm with the owner that nessie.works should lose the
   sign-in-first page before this ships.
6. **Pull request:** one PR from `work3` into `main`; `main` merges when CI is
   green (see `AGENTS.md` → Workflow). Remove `.claude/launch.json` from the PR
   if it should stay local.
