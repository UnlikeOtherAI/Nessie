import assert from 'node:assert/strict'
import test from 'node:test'

import { TOOL_CATEGORIES, TOOL_CATEGORY_IDS } from '@nessie/schemas'

import { SYSTEM_TOOL_DEFINITIONS } from '../src/index.js'

/**
 * The admin used to guess a tool's category from its id prefix and sweep the
 * remainder into one bucket, which had grown to hold 75 of 116 builtins. These
 * are the properties that keep that from happening again: every tool declares
 * a category, every declared category is real, and no single category is
 * allowed to become the new dumping ground.
 */

test('every builtin declares a category, and it is one the vocabulary names', () => {
  const valid = new Set<string>(TOOL_CATEGORY_IDS)
  const undeclared = SYSTEM_TOOL_DEFINITIONS.filter((tool) => !tool.category).map((t) => t.id)
  const unknown = SYSTEM_TOOL_DEFINITIONS
    .filter((tool) => tool.category && !valid.has(tool.category))
    .map((tool) => `${tool.id}:${tool.category}`)

  assert.deepEqual(undeclared, [], 'a builtin with no category has nowhere to render')
  assert.deepEqual(unknown, [], 'a category the vocabulary does not name renders as "Other"')
})

test('no category is a dumping ground', () => {
  const counts = new Map<string, number>()
  for (const tool of SYSTEM_TOOL_DEFINITIONS) {
    counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1)
  }

  // A quarter of the catalogue in one section is the shape of the bucket this
  // replaced. Crossing it means the category has stopped describing anything
  // and needs splitting — not that this number needs raising.
  const ceiling = Math.ceil(SYSTEM_TOOL_DEFINITIONS.length / 4)
  const oversized = [...counts.entries()]
    .filter(([, count]) => count > ceiling)
    .map(([id, count]) => `${id}:${count}`)

  assert.deepEqual(oversized, [], `no category may exceed ${ceiling} of the catalogue`)
})

test('every category in the vocabulary is actually used', () => {
  const used = new Set(SYSTEM_TOOL_DEFINITIONS.map((tool) => tool.category))
  const unused = TOOL_CATEGORIES.filter((category) => !used.has(category.id)).map((c) => c.id)

  // A category nobody is in renders as nothing, so it is dead vocabulary that
  // the next author will guess at.
  assert.deepEqual(unused, [])
})

test('categories carry a label and a one-line description', () => {
  const incomplete = TOOL_CATEGORIES.filter(
    (category) => !category.label.trim() || !category.description.trim(),
  ).map((category) => category.id)

  assert.deepEqual(incomplete, [])
})
