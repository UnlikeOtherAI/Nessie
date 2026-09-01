import { useState } from 'react'

import { ExecutorRunLauncherDialog } from '../../components/features/executors/ExecutorRunLauncherDialog'
import type { AgentRecord } from '../../lib/api-client'

type ExecutorRunLauncherInput = {
  agents: AgentRecord[]
  message: string
  onLaunched: () => void
  projectId?: string
  threadId?: string
}

// Capturing the draft at the explicit launcher click keeps the normal composer
// independent: a direct executor run never silently sends its text twice.
export const useExecutorRunLauncher = ({
  agents,
  message,
  onLaunched,
  projectId,
  threadId,
}: ExecutorRunLauncherInput) => {
  const [initialContent, setInitialContent] = useState('')
  const [open, setOpen] = useState(false)

  return {
    dialog: open ? (
      <ExecutorRunLauncherDialog
        agents={agents}
        initialContent={initialContent}
        onClose={() => setOpen(false)}
        onLaunched={onLaunched}
        open
        projectId={projectId}
        threadId={threadId}
      />
    ) : null,
    open: agents.length > 0 && threadId
      ? () => {
          setInitialContent(message)
          setOpen(true)
        }
      : undefined,
  }
}
