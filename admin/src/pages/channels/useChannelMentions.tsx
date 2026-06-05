import { useCallback, useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MentionEntity } from '../../components/shared/MentionInput'
import { getAgentGlyph } from '../../components/features/channels/channel-helpers'
import type { AgentRecord, UserRecord } from '../../lib/api-client'

interface UseChannelMentionsParams {
  agents: AgentRecord[]
  channelUsers: UserRecord[]
  isConversationSurface: boolean
  onSelectAgent: (agentId: string) => void
}

interface UseChannelMentionsResult {
  mentionEntities: MentionEntity[]
  renderContent: (text: string) => ReactNode
}

export const useChannelMentions = ({
  agents,
  channelUsers,
  isConversationSurface,
  onSelectAgent,
}: UseChannelMentionsParams): UseChannelMentionsResult => {
  const navigate = useNavigate()

  const mentionEntities: MentionEntity[] = useMemo(
    () => [
      ...(isConversationSurface
        ? []
        : agents.map((a) => ({
            id: a.id,
            name: a.name,
            type: 'agent' as const,
            glyph: getAgentGlyph(a),
          }))),
      ...channelUsers.map((u) => ({
        id: u.id,
        name: u.displayName,
        type: 'user' as const,
      })),
    ],
    [agents, channelUsers, isConversationSurface],
  )

  const mentionEntityMap = useMemo(
    () => new Map(mentionEntities.map((entity) => [entity.name, entity])),
    [mentionEntities],
  )
  const sortedMentionNames = useMemo(
    () =>
      [...mentionEntityMap.keys()].sort(
        (left, right) => right.length - left.length,
      ),
    [mentionEntityMap],
  )

  const renderContent = useCallback(
    (text: string): ReactNode => {
      if (!mentionEntityMap.size) return text
      const parts: ReactNode[] = []
      let cursor = 0

      while (cursor < text.length) {
        const atIndex = text.indexOf('@', cursor)
        if (atIndex === -1) {
          parts.push(text.slice(cursor))
          break
        }

        const hasMentionBoundaryBefore =
          atIndex === 0 || /\s/.test(text[atIndex - 1] ?? '')

        if (!hasMentionBoundaryBefore) {
          parts.push(text.slice(cursor, atIndex + 1))
          cursor = atIndex + 1
          continue
        }

        const entityName = sortedMentionNames.find((candidate) => {
          if (!text.startsWith(candidate, atIndex + 1)) {
            return false
          }

          const boundaryChar = text[atIndex + 1 + candidate.length]
          return boundaryChar === undefined || /[\s.,!?;:()[\]{}]/.test(boundaryChar)
        })

        if (!entityName) {
          parts.push(text.slice(cursor, atIndex + 1))
          cursor = atIndex + 1
          continue
        }

        const entity = mentionEntityMap.get(entityName)
        if (entity) {
          if (atIndex > cursor) {
            parts.push(text.slice(cursor, atIndex))
          }
          parts.push(
            <button
              className="mention-tag mention-tag-link"
              key={`${entity.id}:${atIndex}`}
              onClick={() => {
                if (entity.type === 'agent') {
                  onSelectAgent(entity.id)
                  return
                }

                void navigate('/settings/members')
              }}
              title={
                entity.type === 'agent'
                  ? `Open ${entity.name}`
                  : `Open ${entity.name} in workspace users`
              }
              type="button"
            >
              @{entityName}
            </button>,
          )
          cursor = atIndex + 1 + entityName.length
          continue
        }

        parts.push(text.slice(cursor, atIndex + 1))
        cursor = atIndex + 1
      }

      if (parts.length === 0) return text
      return <>{parts}</>
    },
    [mentionEntityMap, navigate, onSelectAgent, sortedMentionNames],
  )

  return { mentionEntities, renderContent }
}
