import { useEffect, useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import {
  useDemonstrations,
  useStartDemonstration,
  useStopDemonstration,
} from '../../../facades/demonstrations/hooks'
import { agentSelectionLabel } from '../../shared/AgentVisibilityPill'
import { Dialog } from '../../shared/Dialog'

export const ChannelRoutineRecordingDialog = ({
  activeChannelId, activeThreadId, boundAgents, onClose, open, recording,
}: {
  activeChannelId: string | null
  activeThreadId: string | null
  boundAgents: AgentRecord[]
  onClose: () => void
  open: boolean
  recording: { id: string } | null
}) => {
  const [selectedRoutineAgentId, setSelectedRoutineAgentId] = useState('')
  const { data: ownDemonstrations = [] } = useDemonstrations()
  const startDemonstration = useStartDemonstration()
  const stopDemonstration = useStopDemonstration()
  const ownRecording = ownDemonstrations.find((entry) => entry.id === recording?.id)

  useEffect(() => {
    if (!selectedRoutineAgentId && boundAgents[0]) {
      setSelectedRoutineAgentId(boundAgents[0].id)
    }
  }, [boundAgents, selectedRoutineAgentId])

  return <Dialog
    description="Teach an agent by doing a routine together once. Only completed, redacted structural tool calls are kept; a recording never runs automatically."
    dismissDisabled={startDemonstration.isPending || stopDemonstration.isPending}
    onClose={onClose}
    open={open}
    title={recording ? 'Routine recording' : 'Record a routine'}
  >
    <div className="grid gap-4">
      {recording ? (
        <>
          <p className="text-sm text-[color:var(--tx2)]">
            Recording is visible to everyone in this channel.
          </p>
          {ownRecording ? (
            <button className="admin-button admin-button-danger"
              disabled={stopDemonstration.isPending}
              onClick={() => {
                void stopDemonstration.mutateAsync(ownRecording.id).then(onClose)
              }} type="button">
              Stop and generalise to a draft Workflow
            </button>
          ) : (
            <p className="text-sm text-[color:var(--tx3)]">
              Another channel member started this recording.
            </p>
          )}
        </>
      ) : (
        <>
          <label className="grid gap-1 text-sm font-medium text-[color:var(--tx)]">
            Agent to teach
            <select className="admin-input"
              onChange={(event) => setSelectedRoutineAgentId(event.target.value)}
              value={selectedRoutineAgentId}>
              {boundAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agentSelectionLabel(agent.name, agent.visibility)}
                </option>
              ))}
            </select>
          </label>
          <button className="admin-button admin-button-primary"
            disabled={!activeChannelId || !activeThreadId || !selectedRoutineAgentId
              || startDemonstration.isPending}
            onClick={() => {
              if (!activeChannelId || !activeThreadId || !selectedRoutineAgentId) return
              // The app-wide mutation default surfaces a failure as a toast.
              void startDemonstration.mutateAsync({
                agentId: selectedRoutineAgentId,
                channelId: activeChannelId,
                threadId: activeThreadId,
              }).then(onClose).catch(() => undefined)
            }} type="button">
            Start recording
          </button>
        </>
      )}
    </div>
  </Dialog>
}
