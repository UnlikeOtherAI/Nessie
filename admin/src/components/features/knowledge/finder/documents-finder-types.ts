import type { ReactNode } from 'react'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'

export type FinderScope =
  | { kind: 'org' }
  | { kind: 'project'; projectId: string }
  | { kind: 'agent'; spaceId: string; agentId: string }

export type DocumentsFinderProps = {
  canManageSpace: boolean
  onCreateRootFolder?: () => void
  onOpenSettings: (folder?: KnowledgePageRecord) => void
  documentPane?: ReactNode
  scope: FinderScope
}
