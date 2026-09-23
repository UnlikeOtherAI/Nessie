import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { BriefAnalysisSummary } from '../src/components/features/deep-water/BriefAnalysisSummary.js'
import { BriefConversation } from '../src/components/features/deep-water/BriefConversation.js'
import { BriefOpenQuestions } from '../src/components/features/deep-water/BriefOpenQuestions.js'
import { BriefSettingsEditor } from '../src/components/features/deep-water/BriefSettingsEditor.js'
import { BriefStartBar } from '../src/components/features/deep-water/BriefStartBar.js'
import { ResearchArtifactActions } from '../src/components/features/deep-water/ResearchArtifactActions.js'
import { ResearchReadinessScreen } from '../src/components/features/deep-water/ResearchReadinessScreen.js'
import { ResearchRunOutcome } from '../src/components/features/deep-water/ResearchRunOutcome.js'
import { AuthSessionProvider } from '../src/providers/AuthSessionProvider.js'
import { REQUESTER, completedRun, researchBrief, researchRun } from './deep-water-research-fixtures.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

/**
 * What the research surfaces draw for a given view: the real components,
 * rendered to markup over a stubbed transport. The flows — typing, Start, the
 * clipboard fallback — are walked in the browser suite
 * (`e2e/research-brief/run.mjs`); this pins what each state shows.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5455/' })

const apiClient = {
  delete: async () => ({}),
  get: async () => null,
  patch: async () => ({}),
  post: async () => ({}),
  put: async () => ({}),
} as unknown as ApiClient

const render = (element: ReactElement): Document => {
  // The session provider reads the stored token in a state initialiser.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: dom.window.localStorage,
    writable: true,
  })
  try {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          AuthSessionProvider,
          null,
          createElement(
            ApiClientProvider,
            { client: apiClient },
            createElement(MemoryRouter, { initialEntries: ['/channels/c'] }, element),
          ),
        ),
      ),
    )
    return new JSDOM(`<body>${html}</body>`).window.document
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

const texts = (doc: Document, selector: string): string[] =>
  [...doc.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '')

test('a finished research offers its report, sources, Copy markdown and nothing public by default', () => {
  const doc = render(createElement(ResearchArtifactActions, { run: completedRun() }))
  assert.deepEqual(texts(doc, '[data-testid="research-artifact-actions"] button, [data-testid="research-artifact-actions"] a'), [
    'Download report (.md)',
    'Download sources (.csv)',
    'Copy markdown',
  ])
})

test('a public report adds the link to research.deepwater.live, opening in a new tab', () => {
  const publicUrl = 'https://research.deepwater.live/heat-pumps-in-victorian-terraces-1a2b3c4d'
  const doc = render(createElement(ResearchArtifactActions, { run: completedRun({ publicUrl }) }))
  const link = doc.querySelector('a')
  assert.equal(link?.textContent?.trim(), 'Open on research.deepwater.live')
  assert.equal(link?.getAttribute('href'), publicUrl)
  assert.equal(link?.getAttribute('target'), '_blank')
  assert.equal(link?.getAttribute('rel'), 'noopener noreferrer')
})

test('a summary downloads as a summary, and a research with no stored artifacts offers none', () => {
  const summary = render(createElement(ResearchArtifactActions, { run: completedRun({ reportKind: 'summary' }) }))
  assert.ok(texts(summary, 'button').includes('Download summary (.md)'))
  const none = render(createElement(ResearchArtifactActions, { run: researchRun({ status: 'running' }) }))
  assert.equal(none.querySelector('[data-testid="research-artifact-actions"]'), null)
})

test('the outcome of a summary says so, and links the summary in Documents', () => {
  const doc = render(createElement(ResearchRunOutcome, {
    meUserId: REQUESTER,
    onStartAgain: null,
    run: completedRun({ reportKind: 'summary', truncated: true }),
    shownIn: 'its_conversation',
  }))
  const lines = texts(doc, '[data-testid="research-run-outcome"] p')
  assert.ok(lines.includes('Finished with 42 sources.'))
  assert.ok(lines.includes('Research summary (the full report could not be written).'))
  assert.ok(lines.some((line) => /research summary was too long to keep in full/.test(line)))
  assert.ok(texts(doc, 'a').includes('Open the research summary in Documents'))
})

test('a blocked delivery names its remedy, and only the requester gets Retry import', () => {
  const blocked = (canRetryDelivery: boolean) => completedRun({
    delivery: { blockedReason: 'knowledge_destination_unavailable', state: 'blocked' },
    report: null,
    status: 'running',
    viewer: { canCancel: false, canEdit: false, canRetryDelivery, canStart: false },
  })
  const own = render(createElement(ResearchRunOutcome, {
    meUserId: REQUESTER, onStartAgain: null, run: blocked(true), shownIn: 'its_conversation',
  }))
  assert.match(own.body.textContent ?? '', /Retry import puts it back/)
  assert.ok(texts(own, 'button').includes('Retry import'))
  const theirs = render(createElement(ResearchRunOutcome, {
    meUserId: null, onStartAgain: null, run: blocked(false), shownIn: 'its_conversation',
  }))
  assert.equal(texts(theirs, 'button').includes('Retry import'), false)
})

test('a failed research of your own offers Start again with its question', () => {
  const failed = researchRun({
    failure: { code: 'scope_rejected', message: 'DeepWater could not start this research.' },
    status: 'failed',
  })
  const doc = render(createElement(ResearchRunOutcome, {
    meUserId: REQUESTER,
    onStartAgain: () => undefined,
    run: failed,
    shownIn: 'elsewhere',
  }))
  assert.ok(texts(doc, 'p').includes('DeepWater could not start this research.'))
  assert.ok(texts(doc, 'button').includes('Start again'))
})

test('a running research says where its result comes back, by where it is shown', () => {
  const running = researchRun({ status: 'running' })
  const line = (shownIn: 'its_conversation' | 'elsewhere') =>
    texts(render(createElement(ResearchRunOutcome, { meUserId: REQUESTER, onStartAgain: null, run: running, shownIn })),
      '[data-testid="research-run-outcome"] p')
  assert.deepEqual(line('its_conversation'),
    ['DeepWater is researching. The result will come back to this conversation.'])
  // Knowledge › Research, the Threads inbox, a brief over another screen: no "this conversation" there.
  assert.deepEqual(line('elsewhere'),
    ['DeepWater is researching. The result will come back to the conversation it was asked in.'])
})

const startBar = (brief = researchBrief(), overrides: Record<string, unknown> = {}) =>
  render(createElement(BriefStartBar, {
    blockedReason: null,
    brief,
    canOfferStart: true,
    cancelling: false,
    error: null,
    onCancel: () => undefined,
    onPublishChange: () => undefined,
    onStart: () => undefined,
    publish: false,
    starting: false,
    ...overrides,
  }))

test('the requester\'s drafting brief offers the publish switch, off, and Start', () => {
  const doc = startBar()
  const toggle = doc.querySelector('[role="switch"]')
  assert.equal(toggle?.getAttribute('aria-label'), 'Publish on research.deepwater.live')
  assert.equal(toggle?.getAttribute('aria-checked'), 'false')
  assert.match(doc.body.textContent ?? '', /Anyone with the link can read the finished report\./)
  assert.ok(texts(doc, 'button').includes('Start research'))
  assert.ok(texts(doc, 'button').includes('Discard brief'))
})

test('Start that cannot be pressed yet says why', () => {
  const doc = startBar(researchBrief(), { blockedReason: 'Add at least one pillar.' })
  const start = [...doc.querySelectorAll('button')].find((button) => button.textContent === 'Start research')
  assert.ok(start?.hasAttribute('disabled'))
  assert.ok(texts(doc, 'p').includes('Add at least one pillar.'))
})

test('an agent\'s brief has no publish switch and says it stays private', () => {
  const agentBrief = researchBrief({
    origin: { ...researchBrief().origin, agentId: '30000000-0000-4000-8000-000000000001', kind: 'agent' },
  })
  const doc = startBar(agentBrief, { canOfferStart: false })
  assert.equal(doc.querySelector('[role="switch"]'), null)
  assert.equal(texts(doc, 'button').includes('Start research'), false)
  assert.match(doc.body.textContent ?? '', /An agent started this research, so it stays private/)
})

test('the seven settings render with their labels, and a person\'s choice shows its lock', () => {
  const brief = researchBrief()
  const doc = render(createElement(BriefSettingsEditor, {
    editable: true,
    editedKeys: new Set(['recency' as const]),
    locked: new Set(['outputLanguage' as const, 'recency' as const]),
    onChange: () => undefined,
    settings: { ...brief.settings!, recency: 'year' },
  }))
  const rows = [...doc.querySelectorAll('[data-setting]')].map((row) => row.getAttribute('data-setting'))
  assert.deepEqual(rows, ['depth', 'chapterDepth', 'searchQuality', 'languages', 'outputLanguage', 'recency', 'writingStyle'])
  const label = (key: string) => doc.querySelector(`[data-setting="${key}"]`)?.textContent ?? ''
  assert.match(label('outputLanguage'), /Report language.*Your choice/)
  assert.match(label('recency'), /Your choice.*Not sent yet/)
  assert.match(label('depth'), /DeepWater chooses/)
  assert.ok(texts(doc, 'button').includes('Let DeepWater choose'))
})

test('read-only settings show values, not controls', () => {
  const doc = render(createElement(BriefSettingsEditor, {
    editable: false,
    editedKeys: new Set(),
    locked: new Set(),
    onChange: () => undefined,
    settings: { ...researchBrief().settings!, languages: ['cs', 'de'] },
  }))
  assert.equal(doc.querySelectorAll('select').length, 0)
  assert.match(doc.querySelector('[data-setting="languages"]')?.textContent ?? '', /Czech, German/)
})

test('suggested answers are one-tap replies, disabled while they cannot be sent', () => {
  const questions = researchBrief().openQuestions
  const live = render(createElement(BriefOpenQuestions, { canAnswer: true, onAnswer: () => undefined, questions }))
  assert.deepEqual(texts(live, 'button'), ['The UK', 'Europe'])
  assert.ok(texts(live, 'p').includes('Grants and building rules differ.'))
  const waiting = render(createElement(BriefOpenQuestions, { canAnswer: false, onAnswer: () => undefined, questions }))
  assert.ok([...waiting.querySelectorAll('button')].every((button) => button.hasAttribute('disabled')))
})

test('the planner\'s assessment offers its suggested depth with one tap, only when it differs', () => {
  const { analysis } = researchBrief()
  const differs = render(createElement(BriefAnalysisSummary, {
    analysis,
    currentDepth: 'standard',
    onUseSuggestedDepth: () => undefined,
  }))
  assert.match(differs.querySelector('[data-testid="research-suggested-depth"]')?.textContent ?? '', /Suggested depth: Deep/)
  assert.ok(texts(differs, 'button').includes('Use Deep'))
  const same = render(createElement(BriefAnalysisSummary, { analysis, currentDepth: 'deep', onUseSuggestedDepth: () => undefined }))
  assert.equal(texts(same, 'button').length, 0)
})

test('not ready: an owner is sent to turn DeepWater on; a member is told who can', () => {
  const owner = render(createElement(ResearchReadinessScreen, { onClose: () => undefined, state: 'team_off', viewerIsOwner: true }))
  const turnOn = owner.querySelector('a')
  assert.equal(turnOn?.textContent, 'Turn on DeepWater')
  assert.equal(turnOn?.getAttribute('href'), '/apps/deep-water')
  const member = render(createElement(ResearchReadinessScreen, { onClose: () => undefined, state: 'team_off', viewerIsOwner: false }))
  assert.equal(member.querySelector('a'), null)
  assert.match(member.body.textContent ?? '', /Ask a team owner to turn it on/)
  const unlinked = render(createElement(ResearchReadinessScreen, {
    onClose: () => undefined,
    state: 'account_not_linked',
    viewerIsOwner: false,
  }))
  assert.ok(texts(unlinked, 'button').includes('Sign in again'))
})

const failedConversation = (sendAgain: string | null) =>
  render(createElement(BriefConversation, {
    brief: researchBrief({
      plannerTurn: { actionId: null, message: 'DeepWater’s research planner couldn’t answer.', retryable: true, status: 'failed' },
    }),
    canCompose: true,
    canSend: true,
    error: null,
    meUserId: REQUESTER,
    message: '',
    onMessageChange: () => undefined,
    onSend: () => undefined,
    sendAgain,
    sending: false,
  }))

test('a reply the planner could not answer offers Send again only when its words are known', () => {
  const known = failedConversation('Only houses built before 1919, please.')
  assert.ok(texts(known, '[role="alert"]').some((line) => line.includes('couldn’t answer')))
  assert.ok(texts(known, 'button').includes('Send again'))
  // Sent from elsewhere and not recorded here: nothing is guessed.
  const unknown = failedConversation(null)
  assert.equal(texts(unknown, 'button').includes('Send again'), false)
  assert.match(unknown.body.textContent ?? '', /Write your reply again below to send it\./)
})
