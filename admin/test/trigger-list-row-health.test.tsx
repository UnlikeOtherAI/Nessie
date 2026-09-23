import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'

import { TriggerListRow } from '../src/components/features/triggers/TriggerListRow'
import type { TriggerRegistryMaps } from '../src/components/features/triggers/trigger-presentation'
import type { AgentTriggerRecord } from '../src/lib/api-client'

const registry: TriggerRegistryMaps = {
  agentsById: new Map(),
  channelsById: new Map(),
  workflowInstallationsById: new Map(),
  workflowTemplatesById: new Map(),
}

const stoppedTrigger: AgentTriggerRecord = {
  config: { interval_minutes: 60 },
  createdAt: new Date(0).toISOString(),
  enabled: false,
  healthReason: 'agent_channel_access_lost',
  id: 'trigger-1',
  name: 'Morning Joke',
  nextRunAt: '2099-01-01T00:00:00.000Z',
  status: 'error',
  type: 'interval',
  updatedAt: new Date(0).toISOString(),
}

test('the trigger list shows the membership error and no runnable next time', () => {
  const markup = renderToStaticMarkup(
    <table>
      <tbody>
        <TriggerListRow onOpen={() => undefined} registry={registry} trigger={stoppedTrigger} />
      </tbody>
    </table>,
  )
  const document = new JSDOM(markup).window.document
  const cells = document.querySelectorAll('td')

  assert.match(document.body.textContent ?? '', /agent is no longer in its target channel/i)
  assert.equal(cells[4]?.textContent, '—')
})
