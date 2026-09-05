import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClientProvider, type ApiClient } from '@nessie/client-core'

import { SidebarChannelsSection } from '../src/layouts/admin-shell/SidebarChannelsSection.js'
import { SidebarEmptyNote } from '../src/layouts/admin-shell/SidebarEmptyNote.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

/**
 * An empty sidebar section explains itself in a quiet line on the row grid.
 *
 * The dashed "Create your first project." call-to-action it replaces read as an
 * error state and sat on its own geometry, so a section that emptied moved its
 * own left edge. These assert the two things a person actually sees: the
 * sentence, and that it starts where `#general` starts.
 */

// The rows prewarm their route on hover, which reads the api client. Nothing
// here navigates, so an unreachable one is enough to render.
const unavailable = () => Promise.reject(new Error('no request in this test'))
const renderChannelsSection = (
  standaloneChannels: Parameters<typeof SidebarChannelsSection>[0]['standaloneChannels'],
): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        ApiClientProvider,
        {
          client: {
            delete: unavailable,
            get: unavailable,
            patch: unavailable,
            post: unavailable,
            put: unavailable,
          } as ApiClient,
        },
        createElement(SidebarChannelsSection, {
          channelsCollapsed: false,
          onNavigateChannel: () => undefined,
          onOpenCreateChannel: () => undefined,
          onToggleStar: () => undefined,
          standaloneChannels,
          starredChannelIds: new Set<string>(),
          toggleChannelsCollapsed: () => undefined,
        }),
      ),
    ),
  )

test('an empty section says so on the row grid, not in a box of its own', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarEmptyNote, null, 'There are no shared channels yet.'),
  )

  assert.match(html, /There are no shared channels yet\./)
  // Row geometry — the same class every `#channel` row carries.
  assert.match(html, /class="[^"]*admin-sb-item[^"]*"/)
  assert.match(html, /class="[^"]*admin-sb-empty[^"]*"/)
  // Nothing to click and nothing to submit: the "+" in the header is the way in.
  assert.doesNotMatch(html, /<button/)
  assert.doesNotMatch(html, /border-dashed/)
})

test('a note inside a project keeps the indent its channels have', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarEmptyNote, { indent: 'child' }, 'There are no channels yet.'),
  )

  assert.match(html, /class="[^"]*sidebar-child[^"]*"/)
})

test('a note one level deeper keeps the indent the boards it stands in for have', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarEmptyNote, { indent: 'grandchild' }, 'There are no boards yet.'),
  )

  assert.match(html, /class="[^"]*sidebar-grandchild[^"]*"/)
})

test('Shared channels with nothing in it explains itself', () => {
  const html = renderChannelsSection([])

  assert.match(html, /There are no shared channels yet\./)
  // The way to add one is still there: the note replaced a call to action, so
  // the header's "+" is now the only one.
  assert.match(html, /aria-label="Create channel"/)
})

test('Shared channels with a channel in it says nothing extra', () => {
  const html = renderChannelsSection([
    { id: 'channel-general', label: 'general', unreadCount: 0 },
  ] as unknown as Parameters<typeof SidebarChannelsSection>[0]['standaloneChannels'])

  assert.match(html, /general/)
  assert.doesNotMatch(html, /There are no shared channels yet\./)
})
