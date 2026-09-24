import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExecutorCodingSessionsFacts, ExecutorDescriptorReviewResponse } from '@nessie/schemas'

import { describeExecutorCodingAgents } from '../src/components/features/executors/ExecutorCodingAgents.js'
import { ExecutorReviewedPolicy } from '../src/components/features/executors/ExecutorReviewedPolicy.js'

/**
 * A reviewer approving a revision that offers the coding bridge reads what the
 * coding agents on that machine may do — from the power facts the signed
 * descriptor carries, and nothing else — next to the confirm control.
 */

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const facts: ExecutorCodingSessionsFacts = {
  agents: ['claude'],
  allowedToolCount: 3,
  configDigest: `sha256:1a2b3c4d5e6f${'0'.repeat(52)}`,
  environmentNames: [],
  permissionMode: { claude: 'acceptEdits' },
  rootNames: ['nessie'],
  serverName: 'coding-sessions',
}

const revision = (codingSessions?: ExecutorCodingSessionsFacts): ExecutorDescriptorReviewResponse => ({
  ...(codingSessions ? { codingSessions } : {}),
  localPolicyDigest: `sha256:${'b'.repeat(64)}`,
  mcpServers: codingSessions ? ['coding-sessions', 'kelpie'] : ['kelpie'],
  operationKeys: ['mcp.tools', 'mcp.call'],
  profiles: ['workspace_sandbox'],
  reviewStatus: 'pending_review',
  revision: 7,
} as ExecutorDescriptorReviewResponse)

const renderReview = (descriptorRevision: ExecutorDescriptorReviewResponse): string => renderToStaticMarkup(
  createElement(ExecutorReviewedPolicy, {
    change: { kind: 'descriptor_review', revision: 7 },
    descriptorRevisions: [descriptorRevision],
  }),
)

const text = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, '\'')

test('the reviewed policy names the coding agents, their stance and their folders', () => {
  const shown = text(renderReview(revision(facts)))
  assert.match(shown, /Coding agents on this machine: Claude Code \(accept edits, 3 pre-allowed commands\) in nessie/)
  assert.match(shown, /They work as this machine’s user, with its files and logins\. Configuration sha256:1a2b3c4d5e6f/)
  assert.doesNotMatch(shown, /Given the variables/, 'no environment line when the configuration names none')
})

test('every field the descriptor carries reaches the sentence', () => {
  assert.equal(
    describeExecutorCodingAgents({
      ...facts,
      agents: ['claude', 'codex'],
      allowedToolCount: 1,
      permissionMode: { claude: 'default', codex: 'bypassApprovalsAndSandbox' },
      rootNames: ['nessie', 'web', 'docs'],
    }),
    'Claude Code (its own settings on the machine, 1 pre-allowed command) and Codex (no approvals and no sandbox) '
    + 'in nessie, web and docs',
  )
  assert.equal(
    describeExecutorCodingAgents({
      ...facts, agents: ['codex'], allowedToolCount: 0, permissionMode: { codex: 'sandbox:workspace-write' },
    }),
    'Codex (sandbox workspace-write) in nessie',
    'Codex has no pre-allowed commands to count',
  )
  const shown = text(renderReview(revision({ ...facts, environmentNames: ['ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'] })))
  assert.match(shown, /Given the variables ANTHROPIC_BASE_URL and CLAUDE_CONFIG_DIR\./)
})

test('the turn budget and the live-session quota read in plain words, and nothing when the machine never said', () => {
  const stated = { ...facts, maxBudgetUsd: { claude: 5 }, maxLiveSessionsPerOwner: 3 }
  const shown = text(renderReview(revision(stated)))
  assert.match(shown, /Claude Code \(accept edits, 3 pre-allowed commands, at most \$5 a turn\) in nessie/)
  assert.match(shown, /Each agent may keep up to 3 sessions open at once for the person it works for\./)
  assert.equal(
    describeExecutorCodingAgents({
      ...facts,
      agents: ['claude', 'codex'],
      maxBudgetUsd: { claude: 2.5, codex: null },
      permissionMode: { claude: 'acceptEdits', codex: 'fullAuto' },
    }),
    'Claude Code (accept edits, 3 pre-allowed commands, at most $2.50 a turn) and Codex (full auto, no spending limit '
    + 'per turn) in nessie',
    'null is a stated fact: nothing bounds that agent’s turns',
  )
  assert.match(
    text(renderReview(revision({ ...stated, maxBudgetUsd: { claude: null }, maxLiveSessionsPerOwner: 1 }))),
    /3 pre-allowed commands, no spending limit per turn\).*Each agent may keep one session open at once/,
  )
  // An older daemon's descriptor states neither: that is a machine that has not said, never one without limits.
  const older = text(renderReview(revision(facts)))
  assert.doesNotMatch(older, /spending limit|a turn\)|sessions? open at once/)
})

test('a revision that does not offer the bridge says nothing about coding agents', () => {
  assert.doesNotMatch(text(renderReview(revision())), /Coding agents/)
})
