// DeepWater's own side of the real-stack research walk (`real-stack.mjs`): a
// research event as DeepWater pushes it (Water plan amendments-streaming S1),
// signed with the key the walk starts the API with and posted to the real
// receiver. The API's embedded worker handles it and announces the run over
// the real realtime transport, so the room's research card moves exactly as it
// would in production. The body keeps DeepWater's member order
// (`docs/contracts/research-event.v1.examples.json` in the Water repo).
import { createHmac, randomBytes } from 'node:crypto'

/** The receiver key the walk starts its API with (32+ characters, as DeepWater requires). */
export const EVENTS_SECRET = 'research-brief-real-events-key-0123456789'

const RECEIVER = '/api/integrations/deep-water/events'

/** Post one signed `research.progress` for a launched research; answers the receiver's status and body. */
export const pushResearchProgress = async (apiUrl, { organizationId, progress, researchId, runId, teamId, userId }) => {
  const now = new Date().toISOString()
  const eventId = `evt_${randomBytes(16).toString('hex')}`
  const body = JSON.stringify({
    ver: 'deepwater.research-event.v1',
    event_id: eventId,
    type: 'research.progress',
    sent_at: now,
    occurred_at: now,
    research: {
      ledger_research_id: researchId,
      status: 'running',
      title: null,
      report_kind: null,
      public_url: null,
      error_code: null,
    },
    progress: { ...progress, at: now },
    turn: null,
    nessie: {
      organization_id: organizationId,
      team_id: teamId,
      user_id: userId,
      run_id: runId,
      agent_id: null,
      tool_call_id: null,
      thread_id: null,
    },
  })
  const response = await fetch(`${apiUrl}${RECEIVER}`, {
    body,
    headers: {
      'content-type': 'application/json',
      'x-deepwater-event-id': eventId,
      'x-deepwater-signature': `sha256=${createHmac('sha256', EVENTS_SECRET).update(body).digest('hex')}`,
    },
    method: 'POST',
  })
  return { body: await response.json(), status: response.status }
}
