import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { useAgents } from '../../../../facades/agents/queries'
import { useChannels } from '../../../../facades/channels/hooks'
import {
  findDocumentReview,
  useDocumentTriggerAccess,
} from '../../../../facades/knowledge/document-trigger-hooks'
import type { KnowledgePageRecord, KnowledgeSpaceRecord } from '../../../../facades/knowledge/hooks'
import { spaceNarrowerThanChannel } from '../../triggers/document-trigger-form'
import { isTicketTargetChannel } from '../../triggers/ticket-trigger-form'
import type { DefaultTarget } from '../../triggers/trigger-config'
import { TriggerEditorDialog } from '../../triggers/TriggerEditorDialog'
import { reviewThreadPath } from './DocumentReviewBadge'
import type { FinderMenuHandlers } from './finder-menu'

/**
 * "Tell an agent when this changes…" from a folder or page's menu in the
 * Finder, and so in a project's Docs tab
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Finder and
 * project docs"): the Triggers editor itself, opened on a document trigger for
 * that folder — or that one page — in its space. Only this project's channels
 * are offered, because a document trigger watches the spaces of its channel's
 * project, and the agents offered first are the ones already in a public
 * channel here. It is offered only to people the Triggers routes let create
 * one (the space's Finder read says so), and only on a space a public project
 * channel may watch; the editor keeps its own draft, so the Triggers page's
 * unsent create is never replaced.
 */

type DocumentTarget = Pick<KnowledgePageRecord, 'id' | 'kind' | 'spaceId' | 'title'>

type FinderDocumentTriggerDialogProps = {
  onClose: () => void
  page: DocumentTarget
  projectId: string
}

export const FinderDocumentTriggerDialog = ({ onClose, page, projectId }: FinderDocumentTriggerDialogProps) => {
  const agentsQuery = useAgents()
  const channelsQuery = useChannels()
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data])
  const channels = useMemo(() => channelsQuery.data ?? [], [channelsQuery.data])
  const projectChannels = useMemo(
    () => channels.filter((channel) => channel.projectId === projectId),
    [channels, projectId],
  )
  const reviewRooms = useMemo(() => projectChannels.filter(isTicketTargetChannel), [projectChannels])
  const ready = useMemo(
    () => agents.filter((agent) => agent.channelIds.some((id) => reviewRooms.some((room) => room.id === id))),
    [agents, reviewRooms],
  )
  const offered = ready.length > 0 ? ready : agents
  const first = offered[0]
  const folder = page.kind === 'folder'
  const defaultTarget = useMemo<DefaultTarget | undefined>(() => first
    ? {
        agentId: first.id,
        targetChannelId: reviewRooms.find((room) => first.channelIds.includes(room.id))?.id,
        targetKind: 'agent',
        prefill: {
          document: folder
            ? { folderPageId: page.id, spaceId: page.spaceId }
            : { pageIds: [page.id], spaceId: page.spaceId },
          name: folder ? `Review changes in ${page.title}` : `Review changes to ${page.title}`,
          triggerType: 'document_changed',
        },
      }
    : undefined, [first, folder, page.id, page.spaceId, page.title, reviewRooms])

  // The editor seeds its draft once, from what it is given when it opens, so it
  // opens only once the agents and channels it prefills from have loaded.
  if (!agentsQuery.isSuccess || !channelsQuery.isSuccess) return null

  return (
    <TriggerEditorDialog
      agents={offered}
      channels={projectChannels}
      defaultTarget={defaultTarget}
      draftId={`document:${page.id}`}
      onClose={onClose}
      onSaved={() => {}}
      open
      workflowInstallations={[]}
      workflowTemplates={[]}
    />
  )
}

/**
 * The Finder menu's document-trigger rows for whichever page a menu opened
 * on — "Open review thread" where a listed review has one the viewer may open,
 * "Tell an agent when this changes…" where the viewer may set one up — and the
 * dialog the second opens.
 */
export const useFinderDocumentTrigger = (space: KnowledgeSpaceRecord | null) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // A space no public channel may watch is never asked about: nothing there can be offered.
  const watchable = space && !spaceNarrowerThanChannel(space) ? space : null
  const projectId = useDocumentTriggerAccess(watchable?.id)
  const [target, setTarget] = useState<DocumentTarget | null>(null)

  const handlersFor = useCallback(
    (page: KnowledgePageRecord | undefined): Pick<FinderMenuHandlers, 'openReviewThread' | 'tellAgent'> => {
      if (!page) return {}
      const thread = findDocumentReview(queryClient, page.spaceId, page.id)?.thread
      return {
        ...(thread ? { openReviewThread: () => void navigate(reviewThreadPath(thread)) } : {}),
        ...(projectId ? { tellAgent: () => setTarget(page) } : {}),
      }
    },
    [navigate, projectId, queryClient],
  )

  const dialog: ReactNode = target && projectId
    ? <FinderDocumentTriggerDialog onClose={() => setTarget(null)} page={target} projectId={projectId} />
    : null

  return { canCreate: projectId !== null, dialog, handlersFor }
}
