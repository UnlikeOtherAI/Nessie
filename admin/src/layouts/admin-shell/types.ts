import type { CSSProperties } from 'react'
import type { ChannelRecord, ProjectRecord } from '../../lib/api-client'

export type StarredItem = { type: 'channel' | 'project' | 'user'; id: string }
export type SidebarProject = ProjectRecord & { channels: ChannelRecord[] }
export type CreateChannelTarget = { projectName?: string; teamId?: string }
export type RenameProjectTarget = { id: string; name: string }
export type SidebarMenu =
  | { type: 'channels' }
  | { type: 'project'; projectId: string }
  | null
export type VisibleStarredEntry =
  | { type: 'channel'; channel: ChannelRecord }
  | { type: 'project'; channels: ChannelRecord[]; project: SidebarProject; starred: boolean }
  | { type: 'user'; person: { dmChannelId?: string; id: string; label: string; style: CSSProperties } }

export const DEFAULT_BOOTSTRAP_PROJECT_ID = '00000000-0000-4000-8000-000000000002'
