import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { workspaceAvatarPath } from '../src/components/primitives/WorkspaceAvatar.js'
import { resolveWorkspaceMenuPosition } from '../src/layouts/admin-shell/workspace-menu-position.js'
import { workspaceSwitchFailureMessage } from '../src/layouts/admin-shell/workspace-switch-message.js'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : []
  })

test('workspace menu stays within the viewport when opened near the top edge', () => {
  const position = resolveWorkspaceMenuPosition(
    { right: 65, top: -24 },
    { width: 1_280, height: 720 },
  )

  assert.equal(position.left, 73)
  assert.equal(position.top, 8)
  assert.equal(position.width, 390)
  assert.ok(position.maxHeight <= 720 * 0.7)
  assert.ok(position.top + position.maxHeight <= 720 - 8)
})

test('workspace menu stays within the right edge of a narrow viewport', () => {
  const position = resolveWorkspaceMenuPosition(
    { right: 780, top: 32 },
    { width: 800, height: 600 },
  )

  assert.equal(position.width, 390)
  assert.equal(position.left, 800 - 390 - 8)
})

test('workspace menu is capped at eighty percent of the available width', () => {
  const position = resolveWorkspaceMenuPosition(
    { right: 40, top: 32 },
    { width: 400, height: 600 },
  )

  assert.equal(position.width, 320)
  assert.equal(position.left, 48)
})

test('workspace pictures prefer the team relay and accept the UOA public fallback', () => {
  assert.equal(workspaceAvatarPath(), '/api/workspace/avatar')
  assert.equal(workspaceAvatarPath(null), null)
  assert.equal(
    workspaceAvatarPath('team/with spaces'),
    '/api/teams/team%2Fwith%20spaces/avatar',
  )

  const avatar = readFileSync(`${sourceRoot}/components/primitives/WorkspaceAvatar.tsx`, 'utf8')
  const switcher = readFileSync(`${sourceRoot}/layouts/admin-shell/WorkspaceSwitcher.tsx`, 'utf8')
  assert.match(avatar, /relayedUrl \?\? imageUrl \?\? null/)
  assert.match(switcher, /imageUrl=\{workspace\.avatarImageUrl\}/)
  assert.ok(
    switcher.match(/imageUrl=\{active\?\.avatarImageUrl\}/g)?.length === 2,
    'both web workspace triggers must render the public avatar fallback',
  )
})

test('UOA workspace rows switch inside Nessie while Add Workspace keeps hosted sign-in', () => {
  const switcher = readFileSync(`${sourceRoot}/layouts/admin-shell/WorkspaceSwitcher.tsx`, 'utf8')
  assert.match(
    switcher,
    /switchUoaWorkspace\(\{\s*organizationId: workspace\.organizationId,\s*teamId: workspace\.teamId,/,
  )
  assert.match(
    switcher,
    /startExternalSignIn\(providerId, resolveAppliedTheme\(theme\)\)/,
  )
  assert.doesNotMatch(switcher, /startExternalSignIn\([\s\S]{0,200}workspace\.teamId/)
  assert.match(switcher, /role="alert"/)
  assert.match(switcher, /busyTeamId=\{busyTeamId\}/)
})

test('workspace-switch errors make the retained workspace explicit', () => {
  const base = workspaceSwitchFailureMessage({
    currentWorkspace: 'Alpha',
    targetWorkspace: 'Beta',
  })
  assert.equal(base, 'Couldn’t switch to Beta. You’re still in Alpha.')
  assert.match(
    workspaceSwitchFailureMessage({
      code: 'INTERACTION_REQUIRED',
      currentWorkspace: 'Alpha',
      targetWorkspace: 'Beta',
    }),
    /requires another sign-in verification/,
  )
  assert.match(
    workspaceSwitchFailureMessage({
      code: 'WORKSPACE_SWITCH_CONFLICT',
      currentWorkspace: 'Alpha',
      targetWorkspace: 'Beta',
    }),
    /Try again/,
  )
})

test('session ownership wraps the app inside the shared tenant query cache', () => {
  const appProvider = readFileSync(`${sourceRoot}/providers/AppProvider.tsx`, 'utf8')
  assert.match(
    appProvider,
    /<QueryProvider>\s*<AuthSessionProvider>\s*<ApiClientProvider>/,
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
    assert.match(
      usage,
      /(?:\buserId=|\{\.\.\.toAvatarSources\()/,
      `${path} must pass the SSO-backed user id to UserAvatar`,
    )
  }
})
