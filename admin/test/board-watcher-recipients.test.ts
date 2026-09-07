import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import { selectBoardWatcherAgents } from '../src/lib/board-watcher-recipients.js'

const agent = (overrides: Partial<AgentRecord>): AgentRecord =>
  ({
    agentKind: 'shared',
    id: overrides.id ?? 'agent',
    name: 'Agent',
    role: 'assistant',
    systemManaged: false,
    visibility: 'team',
    ...overrides,
  }) as AgentRecord

test('watchers offer eligible team and owned private agents only', () => {
  const agents = selectBoardWatcherAgents(
    [
      agent({ id: 'team' }),
      agent({ id: 'mine', ownerUserId: 'viewer', visibility: 'private' }),
      agent({ id: 'another', ownerUserId: 'other', visibility: 'private' }),
      agent({ id: 'system', systemManaged: true }),
      agent({ id: 'slugged', systemSlug: 'agent-designer' }),
      agent({ agentKind: 'personal_assistant', id: 'pa', systemManaged: true }),
    ],
    'viewer',
  )
  assert.deepEqual(agents.map((entry) => entry.id), ['team', 'mine'])
})
