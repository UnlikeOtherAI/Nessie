// Every page on nessie.works other than the homepage, in one list.
//
// Rule zero: a capability is not done until a person can reach it. A page that
// exists at a path nothing links to is not a page. So this list — not the
// route table, not the header, not the footer — is the single place a page is
// declared, and all four read from it. Add an entry and the page gets a route,
// a place in the header menu it belongs to, a row in the docs sidebar and a
// footer link, or it does not ship.

import type { ComponentType } from 'react'

import { ApiPage } from './api'
import { EuPage } from './eu'
import { ExecutorsPage } from './executors'
import { InstallationPage } from './installation'
import { McpPage } from './mcp'
import { PrivacyPage } from './privacy'
import { TermsPage } from './terms'

/**
 * Which header menu a page hangs under. `none` keeps a page out of the top
 * nav entirely — the legal pages live in the footer, where people look for
 * them, and cluttering the main nav with them helps nobody.
 */
export type PageGroup = 'resources' | 'why' | 'none'

export type Page = {
  /** Rendered as the `<h1>` and the browser tab title. */
  title: string
  /** URL path, always absolute and without a trailing slash. */
  path: string
  /** One sentence under the title, and the `<meta name="description">`. */
  summary: string
  group: PageGroup
  /** Shown in the docs sidebar and the footer; defaults to `title`. */
  navLabel?: string
  Component: ComponentType
}

export const pages: Page[] = [
  {
    Component: InstallationPage,
    group: 'resources',
    navLabel: 'Installation',
    path: '/docs/installation',
    summary: 'Run Nessie on infrastructure you choose, from a single machine to a managed cloud.',
    title: 'Installing Nessie',
  },
  {
    Component: ApiPage,
    group: 'resources',
    navLabel: 'API',
    path: '/docs/api',
    summary: 'The HTTP API behind every Nessie client, and how to authenticate against it.',
    title: 'API',
  },
  {
    Component: McpPage,
    group: 'resources',
    navLabel: 'MCP',
    path: '/docs/mcp',
    summary: 'Connect Nessie to MCP servers, and pair an outside agent so it can work in Nessie as you.',
    title: 'MCP and connected tools',
  },
  {
    Component: ExecutorsPage,
    group: 'resources',
    navLabel: 'Remote executors',
    path: '/docs/executors',
    summary: 'Give an agent a real computer to work on — on Linux, macOS or Windows.',
    title: 'Remote executors',
  },
  {
    Component: EuPage,
    group: 'why',
    navLabel: 'EU made and data residency',
    path: '/eu',
    summary: 'Where Nessie is built, where your data lives, and what you control when you host it yourself.',
    title: 'EU made, and where your data lives',
  },
  {
    Component: TermsPage,
    group: 'none',
    navLabel: 'Terms',
    path: '/terms',
    summary: 'The terms you agree to when you use Nessie Cloud or the Nessie source code.',
    title: 'Terms and conditions',
  },
  {
    Component: PrivacyPage,
    group: 'none',
    navLabel: 'Privacy',
    path: '/privacy',
    summary: 'What personal data Nessie processes, why, and what you can ask us to do with it.',
    title: 'Privacy policy',
  },
]

/** The documentation set, in reading order — also the docs sidebar. */
export const docsPages = pages.filter((page) => page.path.startsWith('/docs/'))

export const pagesInGroup = (group: PageGroup): Page[] =>
  pages.filter((page) => page.group === group)

export const legalPages = pages.filter((page) => page.group === 'none')
