import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRecord, ChannelRecord } from '../../../lib/api-client'
import {
  useActiveDemonstrations,
  useDemonstrations,
  useStartDemonstration,
  useStopDemonstration,
} from '../../../facades/demonstrations/hooks'
import { agentSelectionLabel } from '../../shared/AgentVisibilityPill'
import { Dialog } from '../../shared/Dialog'

export function RoutineRecordingDialog({
  activeChannel,
  activeThreadId,
  boundAgents,
  open,
  onClose,
}: {
  activeChannel: ChannelRecord | null
  activeThreadId: string | null
  boundAgents: AgentRecord[]
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('channels')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const { data: activeDemonstrations = [] } = useActiveDemonstrations(activeChannel?.id)
  const { data: ownDemonstrations = [] } = useDemonstrations()
  const start = useStartDemonstration()
  const stop = useStopDemonstration()
  const recording = activeDemonstrations.find(
    (entry) => entry.threadId === activeThreadId && entry.status === 'recording',
  )
  const ownRecording = ownDemonstrations.find((entry) => entry.id === recording?.id)

  useEffect(() => {
    if (!selectedAgentId && boundAgents[0]) setSelectedAgentId(boundAgents[0].id)
  }, [boundAgents, selectedAgentId])

  return (
    <Dialog
      description={t('routine.recordingDescription')}
      dismissDisabled={start.isPending || stop.isPending}
      onClose={onClose}
      open={open}
      title={recording ? t('routine.recordingTitle') : t('routine.recordTitle')}
    >
      <div className="grid gap-4">
        {recording ? (
          <>
            <p className="text-sm text-[color:var(--tx2)]">{t('routine.visibleToChannel')}</p>
            {ownRecording ? (
              <button
                className="admin-button admin-button-danger"
                disabled={stop.isPending}
                onClick={() => void stop.mutateAsync(ownRecording.id).then(onClose)}
                type="button"
              >
                {t('routine.stopAndGeneralise')}
              </button>
            ) : (
              <p className="text-sm text-[color:var(--tx3)]">{t('routine.startedByAnother')}</p>
            )}
          </>
        ) : (
          <>
            <label className="grid gap-1 text-sm font-medium text-[color:var(--tx)]">
              {t('routine.agentToTeach')}
              <select className="admin-input" onChange={(event) => setSelectedAgentId(event.target.value)} value={selectedAgentId}>
                {boundAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agentSelectionLabel(agent.name, agent.visibility)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="admin-button admin-button-primary"
              disabled={!activeChannel || !activeThreadId || !selectedAgentId || start.isPending}
              onClick={() => {
                if (!activeChannel || !activeThreadId || !selectedAgentId) return
                void start
                  .mutateAsync({
                    agentId: selectedAgentId,
                    channelId: activeChannel.id,
                    threadId: activeThreadId,
                  })
                  .then(onClose)
                  .catch(() => undefined)
              }}
              type="button"
            >
              {t('routine.startRecording')}
            </button>
          </>
        )}
      </div>
    </Dialog>
  )
}
