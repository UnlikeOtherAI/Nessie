import { useState } from 'react'
import type { CommsConnectionSummary } from '../../../lib/api-client'
import { useAgents } from '../../../facades/agents/hooks'
import { usePersonalAssistant } from '../../../facades/personal-assistant/hooks'
import {
  useGrantSendAuthorization,
  type SendGrant,
} from '../../../facades/gmail/hooks'
import { SendBoundaryEditor } from './SendBoundaryEditor'
import { agentSelectionLabel } from '../../../components/shared/AgentVisibilityPill'

/**
 * Turning on "act without asking", from settings rather than from an approval.
 *
 * This is the doorway the feature was missing: standing consent could only be
 * created by answering an approval that had already interrupted you, so
 * somebody who simply wanted their assistant running their diary had no way to
 * say so up front.
 *
 * Three positions, and the middle one is the interesting one:
 *   ask     — the default; no grant row exists
 *   judged  — decide within a note I wrote, and ask when unsure
 *   always  — act whenever I ask, no confirmation
 */

type Mode = 'judged' | 'always'

export const AddSendAuthorization = ({
  connection,
  existing,
}: {
  connection: CommsConnectionSummary
  existing: SendGrant[]
}) => {
  const agents = useAgents()
  // The Personal Assistant is system-managed and therefore absent from
  // `GET /api/agents` — and it is the agent most people want here, since it
  // already acts as them. Read it from its own endpoint and put it first.
  const assistant = usePersonalAssistant()
  const grant = useGrantSendAuthorization()
  const [open, setOpen] = useState(false)
  const [agentId, setAgentId] = useState('')
  const [mode, setMode] = useState<Mode>('judged')
  const [boundary, setBoundary] = useState('')
  const [error, setError] = useState<string | null>(null)

  // An agent that already has a grant on this mailbox is managed by its own
  // row above; offering it again would create two ways to set one value.
  const granted = new Set(
    existing
      .filter((entry) => entry.connectionId === connection.id)
      .map((entry) => entry.agentId),
  )
  const assistantAgent = assistant.data?.agent
  const choices = [
    ...(assistantAgent ? [{
      id: assistantAgent.id,
      name: assistantAgent.name,
      visibility: assistantAgent.visibility,
    }] : []),
    ...(agents.data ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      visibility: agent.visibility,
    })),
  ].filter((agent) => !granted.has(agent.id))

  if (!open) {
    return (
      <div className="mt-3">
        <button
          className="text-xs font-semibold text-[color:var(--accent)]"
          data-testid="add-send-authorization"
          onClick={() => setOpen(true)}
          type="button"
        >
          Let an agent act without asking…
        </button>
      </div>
    )
  }

  const save = () => {
    setError(null)
    if (!agentId) {
      setError('Choose an agent.')
      return
    }
    grant.mutate(
      {
        connectionId: connection.id,
        agentId,
        duration: 'forever',
        mode,
        ...(mode === 'judged' ? { boundary } : {}),
      },
      {
        onSuccess: () => {
          setOpen(false)
          setAgentId('')
          setBoundary('')
        },
        onError: () => setError('Could not save that. Please try again.'),
      },
    )
  }

  return (
    <div
      className="mt-3 rounded border border-[color:var(--sep)] p-3"
      data-testid="add-send-authorization-form"
    >
      <label className="block text-[11px] font-semibold text-[color:var(--tx3)]">
        Agent
        <select
          className="mt-1 block w-full rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] px-2 py-1 text-xs text-[color:var(--tx)]"
          onChange={(event) => setAgentId(event.target.value)}
          value={agentId}
        >
          <option value="">Choose an agent…</option>
          {choices.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agentSelectionLabel(agent.name, agent.visibility)}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="mt-3">
        <legend className="text-[11px] font-semibold text-[color:var(--tx3)]">
          What it may do with {connection.externalUserId}
        </legend>
        <label className="mt-1 flex items-start gap-2 text-xs text-[color:var(--tx)]">
          <input
            checked={mode === 'judged'}
            className="mt-0.5"
            name="send-mode"
            onChange={() => setMode('judged')}
            type="radio"
          />
          <span>
            Decide within a note I write
            <span className="block text-[11px] text-[color:var(--tx3)]">
              It handles what you describe and checks with you on anything else.
            </span>
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2 text-xs text-[color:var(--tx)]">
          <input
            checked={mode === 'always'}
            className="mt-0.5"
            name="send-mode"
            onChange={() => setMode('always')}
            type="radio"
          />
          <span>
            Act whenever I ask, without confirming
            <span className="block text-[11px] text-[color:var(--tx3)]">
              No approval prompts — including for calendar events with guests.
            </span>
          </span>
        </label>
      </fieldset>

      {mode === 'judged' ? (
        <SendBoundaryEditor
          disabled={grant.isPending}
          onChange={setBoundary}
          value={boundary}
        />
      ) : null}

      <p className="mt-2 text-[11px] leading-4 text-[color:var(--tx3)]">
        Either way this only applies when you ask — never to a schedule or an
        automation — and never to an account other than this one.
      </p>

      {error ? (
        <p className="mt-1 text-[11px] text-[color:var(--danger-text)]">{error}</p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          className="admin-button admin-button-primary"
          disabled={
            grant.isPending
            || !agentId
            || (mode === 'judged' && boundary.trim().length === 0)
          }
          onClick={save}
          type="button"
        >
          Save
        </button>
        <button
          className="admin-button admin-button-secondary"
          disabled={grant.isPending}
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
