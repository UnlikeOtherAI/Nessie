import { useState } from 'react'

import { ExecutorLeaseIndicator } from '../../components/features/executors/ExecutorLeaseIndicator'
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
    // What a launch of local apps leaves behind in this conversation, for the
    // person who launched it; the server answers everyone else with nothing.
    // Asked only where the launcher itself is offered, since only it opens one.
    leaseIndicator: agents.length > 0 && threadId
      ? <ExecutorLeaseIndicator agents={agents} threadId={threadId} />
      : null,
    open: agents.length > 0 && threadId
      ? () => {
          setInitialContent(message)
          setOpen(true)
        }
      : undefined,
  }
}
