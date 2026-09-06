import assert from 'node:assert/strict'
import test from 'node:test'

import { EFFECTFUL_TOOL_CATEGORY_IDS } from '@nessie/schemas'

import {
  BUILTIN_TOOL_DEFINITIONS,
  EFFECTFUL_BUILTIN_TOOL_IDS,
  STRUCTURALLY_APPROVAL_GATED_TOOL_IDS,
} from '../src/index.js'

/**
 * Which builtins the tool-effect ledger claims before it dispatches them
 * (horizontal scaling, invariant 4). The set is a *derivation* over the
 * definitions, so the properties worth pinning are the ones a future edit to a
 * definition could break silently.
 */

const definitionOf = (id: string) => BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === id)

test('`delegate` is claimed: it declares an effectful category and must not call itself safe', () => {
  const delegate = definitionOf('delegate')
  assert.ok(delegate, '`delegate` is a builtin the catalogue carries')
  assert.equal(delegate.category, 'agents')
  assert.equal(
    EFFECTFUL_TOOL_CATEGORY_IDS.has(delegate.category),
    true,
    'the category was already judged effectful — only the `safe` flag ever excluded the tool',
  )
  assert.equal(
    delegate.safe,
    false,
    'a delegation is not a read: the sub-agent inherits the parent run’s builtins minus `delegate`, '
    + 'so it can send mail, file a ticket, or ring somebody',
  )
  assert.equal(
    EFFECTFUL_BUILTIN_TOOL_IDS.has('delegate'),
    true,
    'so a resumed run answers the delegation from its recorded digest instead of dispatching a second sub-agent',
  )
})

test('`spawn_subtask` is claimed: the same declaration, and durable rows a person can see', () => {
  const spawn = definitionOf('spawn_subtask')
  assert.ok(spawn, '`spawn_subtask` is a builtin the catalogue carries')
  assert.equal(spawn.category, 'agents')
  assert.equal(
    EFFECTFUL_TOOL_CATEGORY_IDS.has(spawn.category),
    true,
    'the category was already judged effectful — only the `safe` flag ever excluded the tool',
  )
  assert.equal(
    spawn.safe,
    false,
    'a spawn is not a read: `worker/src/run/subtask-tools.ts` creates a child Agent, its Run and its Task '
    + 'in one transaction and enqueues that run',
  )
  assert.equal(
    EFFECTFUL_BUILTIN_TOOL_IDS.has('spawn_subtask'),
    true,
    'so a resumed run answers from the recorded row instead of minting a second child agent, task and run',
  )
})

test('no builtin that declares itself safe is claimed — a row for a read-only tool is pure cost', () => {
  const claimedButSafe = BUILTIN_TOOL_DEFINITIONS
    .filter((tool) => tool.safe && EFFECTFUL_BUILTIN_TOOL_IDS.has(tool.id))
    .map((tool) => tool.id)

  assert.deepEqual(claimedButSafe, [])
})

test('nothing is claimed by name: every member earns it through its declaration', () => {
  const unexplained = [...EFFECTFUL_BUILTIN_TOOL_IDS].filter((id) => {
    const tool = definitionOf(id)
    if (!tool) return true
    return !(
      EFFECTFUL_TOOL_CATEGORY_IDS.has(tool.category)
      || STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(tool.id)
    )
  })

  assert.deepEqual(
    unexplained,
    [],
    'a hand-kept id list is the thing this set exists not to be — membership follows the category a tool already had to choose',
  )
})
