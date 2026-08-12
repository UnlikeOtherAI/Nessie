import type { CSSProperties } from 'react'
import type { AgentRecord, ChannelRecord, ProjectRecord } from '../../lib/api-client'

export type FavoriteStarredItem = { type: 'agent' | 'channel' | 'user'; id: string }
export type PreferenceStarredItem = { type: 'channel' | 'project' | 'user'; id: string }
export type StarredItem = FavoriteStarredItem | { type: 'project'; id: string }
export type SidebarProject = ProjectRecord & { channels: ChannelRecord[] }
export type CreateChannelTarget = { projectName?: string; teamId?: string }
export type RenameProjectTarget = { id: string; name: string }
export type SidebarMenu =
  | { type: 'channels' }
  | { type: 'project'; projectId: string }
  | null
export type SidebarPerson = {
  dmChannelId?: string
  id: string
  label: string
  style: CSSProperties
  avatarUrl?: string | null
  avatarAttachmentId?: string | null
}
export type SidebarAgentDm = {
  dmChannelId: string
  id: string
  label: string
}
export type SidebarGroupDm = {
  dmChannelId: string
  label: string
}
// A product-declared chat assistant (e.g. DeepSignal) pinned under the Personal
// Assistant. Derived from the surface registry joined to the resolved
// external-agent channel; `productSlug` keeps it traceable to its manifest.
export type SidebarProductAssistant = {
  dmChannelId: string
  productSlug: string
  label: string
  iconGlyph?: string
}
export type VisibleStarredEntry =
  | { type: 'agent'; agent: AgentRecord }
  | { type: 'channel'; channel: ChannelRecord }
  | { type: 'project'; channels: ChannelRecord[]; project: SidebarProject; starred: boolean }
  | { type: 'user'; person: SidebarPerson }

export type AdminShellOutletContext = {
  onCreateAgent: () => void
  onCreateChannel: (target?: CreateChannelTarget) => void
  onSelectAgent: (agentId: string) => void
}

export const DEFAULT_BOOTSTRAP_PROJECT_ID = '00000000-0000-4000-8000-000000000002'
