import { useCallback, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { MentionEntity } from '../../components/shared/MentionInput'
import { getAgentGlyph } from '../../components/features/channels/channel-helpers'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../lib/api-client'
import {
  buildChannelMentionTargets,
  type ChannelMentionTarget,
} from './channelMentionTargets'

interface UseChannelMentionsParams {
  agents: AgentRecord[]
  channels: ChannelRecord[]
  channelUsers: UserRecord[]
  isConversationSurface: boolean
}

interface UseChannelMentionsResult {
  mentionEntities: MentionEntity[]
  renderContent: (text: string) => ReactNode
}

const tokenBoundaryAfter = /[\s.,!?;:()[\]{}\u00A0]/
const tokenBoundaryBefore = /[\s([{\u00A0]/

const hasTokenBoundaryBefore = (text: string, index: number): boolean =>
  index === 0 || tokenBoundaryBefore.test(text[index - 1] ?? '')

const findTokenName = (
  text: string,
  startIndex: number,
  candidates: string[],
): string | undefined =>
  candidates.find((candidate) => {
    const candidateText = text.slice(startIndex, startIndex + candidate.length)
    if (candidateText.toLowerCase() !== candidate.toLowerCase()) {
      return false
    }

    const boundaryChar = text[startIndex + candidate.length]
    return boundaryChar === undefined || tokenBoundaryAfter.test(boundaryChar)
  })

const findNextTrigger = (
  text: string,
  cursor: number,
): { index: number; marker: '@' | '#' } | null => {
  const atIndex = text.indexOf('@', cursor)
  const hashIndex = text.indexOf('#', cursor)

  if (atIndex === -1 && hashIndex === -1) {
    return null
  }

  if (hashIndex === -1 || (atIndex !== -1 && atIndex < hashIndex)) {
    return { index: atIndex, marker: '@' }
  }

  return { index: hashIndex, marker: '#' }
}

function findTokenMatch<T>(
  text: string,
  startIndex: number,
  candidates: Array<{ name: string; value: T }>,
): { name: string; text: string; value: T } | undefined {
  for (const candidate of candidates) {
    const tokenText = text.slice(startIndex, startIndex + candidate.name.length)
    if (tokenText.toLowerCase() !== candidate.name.toLowerCase()) {
      continue
    }

    const boundaryChar = text[startIndex + candidate.name.length]
    if (boundaryChar === undefined || tokenBoundaryAfter.test(boundaryChar)) {
      return { name: candidate.name, text: tokenText, value: candidate.value }
    }
  }

  return undefined
}

export const useChannelMentions = ({
  agents,
  channels,
  channelUsers,
  isConversationSurface,
}: UseChannelMentionsParams): UseChannelMentionsResult => {
  const channelMentionTargets = useMemo(
    () => buildChannelMentionTargets(channels),
    [channels],
  )

  const mentionEntities: MentionEntity[] = useMemo(
    () => [
      ...(isConversationSurface
        ? []
        : agents.map((a) => ({
            id: a.id,
            name: a.name,
            type: 'agent' as const,
            trigger: '@' as const,
            glyph: getAgentGlyph(a),
          }))),
      ...channelUsers.map((u) => ({
        id: u.id,
        name: u.displayName,
        type: 'user' as const,
        trigger: '@' as const,
      })),
      ...channelMentionTargets.map((target) => ({
        detail: target.detail,
        id: target.channel.id,
        name: target.name,
        type: 'channel' as const,
        trigger: '#' as const,
      })),
    ],
    [agents, channelMentionTargets, channelUsers, isConversationSurface],
  )

  const mentionEntityMap = useMemo(
    () =>
      new Map(
        mentionEntities
          .filter((entity) => entity.trigger === '@')
          .map((entity) => [entity.name, entity]),
      ),
    [mentionEntities],
  )
  const channelCandidates = useMemo(
    () =>
      channelMentionTargets
        .map((target): { name: string; value: ChannelMentionTarget } => ({
          name: target.name,
          value: target,
        }))
        .sort((left, right) => right.name.length - left.name.length),
    [channelMentionTargets],
  )
  const dmChannelByUserId = useMemo(
    () =>
      new Map(
        channelUsers
          .map((user): [string, ChannelRecord | undefined] => [
            user.id,
            channels.find(
              (channel) =>
                channel.type === 'dm' && user.channelIds.includes(channel.id),
            ),
          ])
          .filter(
            (entry): entry is [string, ChannelRecord] => entry[1] !== undefined,
          ),
      ),
    [channels, channelUsers],
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
      if (!mentionEntityMap.size && !channelCandidates.length) return text
      const parts: ReactNode[] = []
      let cursor = 0

      while (cursor < text.length) {
        const trigger = findNextTrigger(text, cursor)
        if (!trigger) {
          parts.push(text.slice(cursor))
          break
        }

        if (!hasTokenBoundaryBefore(text, trigger.index)) {
          parts.push(text.slice(cursor, trigger.index + 1))
          cursor = trigger.index + 1
          continue
        }

        if (trigger.marker === '#') {
          const channelMatch = findTokenMatch(
            text,
            trigger.index + 1,
            channelCandidates,
          )
          const channel = channelMatch?.value.channel

          if (channel && channelMatch) {
            if (trigger.index > cursor) {
              parts.push(text.slice(cursor, trigger.index))
            }
            parts.push(
              <Link
                className="mention-tag mention-tag-link"
                key={`channel:${channel.id}:${trigger.index}`}
                title={`Open #${channel.label} in ${channelMatch.value.detail}`}
                to={`/channels/${channel.id}`}
              >
                #{channelMatch.text}
              </Link>,
            )
            cursor = trigger.index + 1 + channelMatch.name.length
            continue
          }

          parts.push(text.slice(cursor, trigger.index + 1))
          cursor = trigger.index + 1
          continue
        }

        const entityName = findTokenName(
          text,
          trigger.index + 1,
          sortedMentionNames,
        )

        if (!entityName) {
          parts.push(text.slice(cursor, trigger.index + 1))
          cursor = trigger.index + 1
          continue
        }

        const entity = mentionEntityMap.get(entityName)
        if (entity) {
          if (trigger.index > cursor) {
            parts.push(text.slice(cursor, trigger.index))
          }
          const dmChannel = entity.type === 'user'
            ? dmChannelByUserId.get(entity.id)
            : undefined
          parts.push(entity.type === 'agent' ? (
            <Link
              className="mention-tag mention-tag-link"
              key={`${entity.id}:${trigger.index}`}
              title={`Open ${entity.name}`}
              to={`/agents/designer/${entity.id}`}
            >
              @{entityName}
            </Link>
          ) : (
            <Link
              className="mention-tag mention-tag-link"
              key={`${entity.id}:${trigger.index}`}
              title={
                dmChannel
                  ? `Open chat with ${entity.name}`
                  : `Open ${entity.name} in workspace users`
              }
              to={dmChannel ? `/channels/${dmChannel.id}` : '/settings/members'}
            >
              @{entityName}
            </Link>
          ))
          cursor = trigger.index + 1 + entityName.length
          continue
        }

        parts.push(text.slice(cursor, trigger.index + 1))
        cursor = trigger.index + 1
      }

      if (parts.length === 0) return text
      return <>{parts}</>
    },
    [
      channelCandidates,
      dmChannelByUserId,
      mentionEntityMap,
      sortedMentionNames,
    ],
  )

  return { mentionEntities, renderContent }
}
