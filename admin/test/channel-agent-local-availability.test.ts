import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../src/components/features/channels/ChannelAgentInfoDrawer.tsx', import.meta.url),
  'utf8',
)

test('the addressed-agent drawer reuses local availability once, with owner-only repair', () => {
  assert.match(source, /import \{ AgentAvailability \} from '\.\.\/agents\/AgentAvailability'/)
  assert.equal([...source.matchAll(/<AgentAvailability/g)].length, 1)
  assert.match(source, /<AgentAvailability\s+agentId=\{agent\.id\}/)
  assert.match(source, /canRepair=\{agent\.ownerUserId === meUserId && agent\.systemManaged !== true\}/)
  assert.match(source, /localBindingId=\{agent\.localInferenceBindingId\}/)
  assert.match(source, /provider=\{agent\.provider\}/)
})
