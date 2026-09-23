import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSearchResultItems,
  SEARCH_SECTION_ORDER,
} from '../src/components/features/search/search-result-items.js'
import type { GlobalSearchResults } from '../src/facades/search/hooks.js'

const results = {
  appliedQuery: 'road',
  agents: [{ id: 'agent-1', name: 'Road planner', role: 'Plans journeys' }],
  apps: [{
    aliases: ['road maps'],
    displayName: 'Maps',
    id: 'app-1',
    shortDescription: 'Map connected work',
    slug: 'maps',
    tags: [],
  }],
  channels: [{
    access: 'limited',
    description: 'Roadmap discussions',
    id: 'channel-1',
    label: 'planning',
    members: [],
    projectName: 'Launch',
    teamName: 'Product',
    visibility: 'protected',
  }],
  errorMessage: null,
  invalidTaskCursor: false,
  isLoading: false,
  knowledge: [{
    page: { id: 'page-1', spaceId: 'space-1', summary: null, title: 'Road handbook' },
    passages: [{ content: 'The launch road goes north.', endOffset: 27, score: 0.8, startOffset: 0 }],
    snippet: 'fallback',
  }],
  messages: [{
    authorName: 'Ada',
    channelId: 'channel-1',
    channelLabel: 'planning',
    createdAt: '2026-09-23T00:00:00.000Z',
    id: 'message-1',
    snippet: 'The road is clear',
    threadId: 'thread-1',
  }],
  people: [{
    channelIds: ['dm-1'],
    displayName: 'Road Runner',
    email: 'runner@example.test',
    id: 'person-1',
  }],
  projects: [{
    access: 'limited',
    description: 'The protected road project',
    id: 'project-1',
    members: [],
    name: 'Road launch',
    visibility: 'protected',
  }],
  restartTaskSearch: () => undefined,
  taskPagination: {},
  tasks: [{
    detail: 'Ship the road plan',
    externalLink: null,
    id: 'task-1',
    projectId: 'project-2',
    purpose: null,
    title: 'Approve roadmap',
  }],
  thoughts: [{ content: 'A remembered road decision', id: 'thought-1' }],
} as unknown as GlobalSearchResults

test('the shared result map includes every global-search section', () => {
  const items = buildSearchResultItems(results, 'road', 'semantic')
  assert.deepEqual(items.map((item) => item.section), SEARCH_SECTION_ORDER)
})

test('message and ticket results deep-link to the exact object', () => {
  const items = buildSearchResultItems(results, 'road', 'fulltext')
  assert.equal(
    items.find((item) => item.id === 'message:message-1')?.href,
    '/channels/channel-1/threads/thread-1?messageId=message-1',
  )
  assert.equal(
    items.find((item) => item.id === 'task:task-1')?.href,
    '/projects/project-2/board?task=task-1',
  )
})

test('a protected project result stays informative without an opening link', () => {
  const items = buildSearchResultItems(results, 'road', 'fulltext')
  const project = items.find((item) => item.id === 'project:project-1')
  assert.equal(project?.href, undefined)
  assert.equal(project?.secondary, 'The protected road project')
  assert.deepEqual(project?.subject, {
    kind: 'project',
    project: null,
    visibility: 'protected',
  })
})

test('a protected channel result never opens an unrelated visible room', () => {
  const items = buildSearchResultItems(results, 'road', 'fulltext')
  assert.equal(items.find((item) => item.id === 'channel:channel-1')?.href, undefined)
})

test('a public project search result remains openable for a non-member', () => {
  const publicResults = {
    ...results,
    projects: [{ ...results.projects[0], visibility: 'public' }],
  } as GlobalSearchResults
  const items = buildSearchResultItems(publicResults, 'road', 'fulltext')
  assert.equal(
    items.find((item) => item.id === 'project:project-1')?.href,
    '/projects/project-1',
  )
})

test('app results explain alias matches and autocomplete bounds each section', () => {
  const duplicated = {
    ...results,
    apps: [results.apps[0], results.apps[0], results.apps[0]],
  } as GlobalSearchResults
  const items = buildSearchResultItems(duplicated, 'road', 'fulltext', { limitPerSection: 2 })
  const apps = items.filter((item) => item.section === 'Apps')
  assert.equal(apps.length, 2)
  assert.equal(apps[0]?.secondary, 'Alias: road maps')
})
