import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { teamAvatarPath } from '../src/components/primitives/TeamAvatar.js'
import { placePopover } from '../src/components/overlays/placePopover.js'
import { teamSwitchFailureMessage } from '../src/layouts/admin-shell/team-switch-message.js'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : []
  })

// The team menu no longer owns any placement arithmetic: it declares a
// preferred side and its width, and the one placePopover helper keeps it on
// screen. These pin that the rail's geometry still lands where it used to.
const placeTeamMenu = (
  anchor: { right: number; top: number },
  viewport: { width: number; height: number },
  panelHeight = 320,
) => placePopover({
  anchor: { bottom: anchor.top + 32, left: anchor.right - 32, right: anchor.right, top: anchor.top },
  bounds: { bottom: viewport.height, left: 0, right: viewport.width, top: 0 },
  panel: { height: panelHeight, width: 390 },
  placement: 'right',
})

test('team menu stays within the viewport when opened near the top edge', () => {
  const position = placeTeamMenu({ right: 65, top: -24 }, { width: 1_280, height: 720 })

  assert.equal(position.left, 73)
  assert.equal(position.top, 8)
  assert.ok(position.top + position.maxHeight <= 720 - 8)
})

// The old arithmetic had no flip: against a narrow window it clamped the menu
// left until it lay across the rail button that opened it. It now opens on the
// other side of the anchor instead.
test('team menu flips to the other side of its trigger rather than covering it', () => {
  const position = placeTeamMenu({ right: 780, top: 32 }, { width: 800, height: 600 })

  assert.equal(position.placement, 'left')
  assert.equal(position.left, 748 - 8 - 390)
  assert.ok(position.left >= 8)
})

// Width is the menu's own design constraint and is now stated in CSS, so no
// code re-reads the viewport for it.
test('the team menu caps its own width in CSS, not from a window read', () => {
  const menu = readFileSync(`${sourceRoot}/layouts/admin-shell/TeamMenu.tsx`, 'utf8')
  assert.match(menu, /const MENU_WIDTH = 'min\(390px, 80vw\)'/)
  assert.doesNotMatch(menu, /innerWidth/)
})

test('team pictures prefer the team relay and accept the UOA public fallback', () => {
  assert.equal(teamAvatarPath(), '/api/team/avatar')
  assert.equal(teamAvatarPath(null), null)
  assert.equal(
    teamAvatarPath('team/with spaces'),
    '/api/teams/team%2Fwith%20spaces/avatar',
  )

  const avatar = readFileSync(`${sourceRoot}/components/primitives/TeamAvatar.tsx`, 'utf8')
  const menu = readFileSync(`${sourceRoot}/layouts/admin-shell/TeamMenu.tsx`, 'utf8')
  const switcher = readFileSync(`${sourceRoot}/layouts/admin-shell/TeamSwitcher.tsx`, 'utf8')
  assert.match(avatar, /relayedUrl \?\? imageUrl \?\? null/)
  assert.match(menu, /imageUrl=\{team\.avatarImageUrl\}/)
  assert.ok(
    switcher.match(/imageUrl=\{active\?\.avatarImageUrl\}/g)?.length === 2,
    'both web team triggers must render the public avatar fallback',
  )
  assert.match(switcher, /faChevronDown/)
  assert.match(switcher, /bottom-0\.5 right-0\.5/)
  assert.match(switcher, /h-\[10px\] w-\[10px\][\s\S]*?rounded-\[3px\]/)
  assert.match(switcher, /<FontAwesomeIcon[\s\S]*?className=\{\[[\s\S]*?rotate-180/)
  assert.match(switcher, /icon=\{faChevronDown\}/)
  assert.match(switcher, /open \? 'rotate-180' : 'rotate-0'/)
  // The menu's own fade/mount timer is gone: opening and closing is the
  // Popover primitive's motion, on the overlay scale's popover token.
  assert.match(menu, /<Popover/)
  assert.doesNotMatch(menu, /transition-\[opacity,transform\]/)
  assert.doesNotMatch(switcher, /setMenuMounted/)
  assert.match(switcher, /open=\{open\}/)
})

test('UOA team rows switch inside Nessie while Add Team keeps hosted sign-in', () => {
  const menu = readFileSync(`${sourceRoot}/layouts/admin-shell/TeamMenu.tsx`, 'utf8')
  const switcher = readFileSync(`${sourceRoot}/layouts/admin-shell/TeamSwitcher.tsx`, 'utf8')
  assert.match(
    switcher,
    /switchUoaTeam\(\{\s*organizationId: team\.organizationId,\s*teamId: team\.teamId,/,
  )
  assert.match(
    switcher,
    /startExternalSignIn\(providerId, signInTheme\)/,
  )
  assert.doesNotMatch(switcher, /startExternalSignIn\([\s\S]{0,200}team\.teamId/)
  assert.match(menu, /role="alert"/)
  assert.match(switcher, /busyTeamId=\{busyTeamId\}/)
})

test('team-switch errors make the retained team explicit', () => {
  const base = teamSwitchFailureMessage({
    currentTeam: 'Alpha',
    targetTeam: 'Beta',
  })
  assert.equal(base, 'Couldn’t switch to Beta. You’re still in Alpha.')
  assert.match(
    teamSwitchFailureMessage({
      code: 'INTERACTION_REQUIRED',
      currentTeam: 'Alpha',
      targetTeam: 'Beta',
    }),
    /requires another sign-in verification/,
  )
  assert.match(
    teamSwitchFailureMessage({
      code: 'TEAM_SWITCH_CONFLICT',
      currentTeam: 'Alpha',
      targetTeam: 'Beta',
    }),
    /Try again/,
  )
})

test('session ownership wraps the app inside the shared tenant query cache', () => {
  const appProvider = readFileSync(`${sourceRoot}/providers/AppProvider.tsx`, 'utf8')
  assert.match(
    appProvider,
    /<QueryProvider>\s*<AuthSessionProvider>\s*<ExternalAuthProvider>\s*<ApiClientProvider>/,
  )
  const authProvider = readFileSync(`${sourceRoot}/providers/AuthSessionProvider.tsx`, 'utf8')
  assert.match(authProvider, /await queryClient\.cancelQueries\(\)\.catch\(\(\) => undefined\)/)
  assert.match(authProvider, /queryClient\.clear\(\)/)
})

test('every shared UserAvatar usage supplies the SSO user identity source', () => {
  const usages = sourceFiles(sourceRoot)
    .filter((path) => !path.endsWith('/components/primitives/UserAvatar.tsx'))
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(/<UserAvatar[\s\S]*?\/>/g)].map((match) => ({
        path,
        usage: match[0],
      }))
    })

  assert.ok(usages.length >= 15, 'expected every human-avatar surface to use UserAvatar')
  for (const { path, usage } of usages) {
    // Either identifier reaches the same UnlikeOtherAI picture: a Nessie user id
    // through the organisation-scoped relay, a UOA subject through the
    // roster-scoped one (for a team roster row with no local user row).
    // What is refused is a surface that renders a person with neither.
    assert.match(
      usage,
      /(?:\buserId=|\buoaSub=|\{\.\.\.toAvatarSources\()/,
      `${path} must pass an SSO-backed identity (userId or uoaSub) to UserAvatar`,
    )
  }
})
