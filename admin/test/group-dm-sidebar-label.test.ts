import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupDmSidebarLabelCandidates,
  selectGroupDmSidebarLabel,
} from '../src/layouts/admin-shell/group-dm-sidebar-label'

test('group DM labels initialise surnames before hiding participants', () => {
  const candidates = groupDmSidebarLabelCandidates('Pavel Fuchs, Viliam Kopecky, Kuba Rafaj, Hardware Watch')

  assert.deepEqual(candidates.map((candidate) => candidate.text), [
    'Pavel Fuchs, Viliam Kopecky, Kuba Rafaj, Hardware Watch',
    'Pavel F., Viliam K., Kuba R., Hardware W.',
    'Pavel F., Viliam K., Kuba R. … +1',
    'Pavel F., Viliam K. … +2',
    'Pavel F. … +3',
    '… +4',
  ])
})

test('group DM labels retain a visible prefix and accurately count hidden participants', () => {
  const candidates = groupDmSidebarLabelCandidates('Pavel Fuchs, Viliam Kopecky, Kuba Rafaj, Hardware Watch')
  const widthByText = new Map(candidates.map((candidate, index) => [candidate.text, 240 - index * 40]))

  const selected = selectGroupDmSidebarLabel(
    candidates,
    120,
    (text) => widthByText.get(text) ?? Number.POSITIVE_INFINITY,
  )

  assert.equal(selected.text, 'Pavel F., Viliam K. … +2')
  assert.equal(selected.hiddenParticipantCount, 2)
})
