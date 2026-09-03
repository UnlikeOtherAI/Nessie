import { useCallback, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { MentionEntity } from '../../components/shared/MentionInput'
import { getAgentGlyph } from '../../components/features/channels/channel-helpers'
import { useNavigateToAgentDm } from '../../facades/channels/dm-navigation'
import { isUserDmChannel } from '../../facades/personal-assistant/hooks'
import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
  UserRecord,
} from '../../lib/api-client'
import {
  buildChannelMentionTargets,
  normalizeChannelLabel,
  type ChannelMentionTarget,
} from './channelMentionTargets'

interface UseChannelMentionsParams {
  activeChannel?: ChannelRecord | null
  agents: AgentRecord[]
  channels: ChannelRecord[]
  channelUsers: UserRecord[]
  personalAssistantPresences?: PersonalAssistantPresenceParticipant[]
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

// `agents` is the entitlement-scoped `GET /api/agents` result supplied by the
// page. Keep that server decision intact: filtering again here would both
// duplicate the privacy rule and make the client an accidental authority.
export const buildAgentMentionEntities = (agents: AgentRecord[]): MentionEntity[] =>
  agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    type: 'agent' as const,
    trigger: '@' as const,
    glyph: getAgentGlyph(agent),
  }))

export const buildPersonalAssistantMentionEntities = (
  presences: PersonalAssistantPresenceParticipant[],
): MentionEntity[] =>
  presences.map((presence) => ({
    id: presence.agentId,
    insertName: presence.mentionName,
    name: presence.displayName,
    principalUserId: presence.principalUserId,
    type: 'agent' as const,
    trigger: '@' as const,
  }))

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
  activeChannel,
  agents,
  channels,
  channelUsers,
  personalAssistantPresences = [],
}: UseChannelMentionsParams): UseChannelMentionsResult => {
  const navigateToAgentDm = useNavigateToAgentDm()
  const channelMentionTargets = useMemo(
    () => buildChannelMentionTargets(channels),
    [channels],
  )

  const mentionEntities: MentionEntity[] = useMemo(
    () => [
      ...buildAgentMentionEntities(agents),
      ...buildPersonalAssistantMentionEntities(personalAssistantPresences),
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
    [agents, channelMentionTargets, channelUsers, personalAssistantPresences],
  )

  const mentionEntityMap = useMemo(
    () =>
      new Map(
        mentionEntities
          .filter((entity) => entity.trigger === '@' && !entity.principalUserId)
          .map((entity) => [entity.name, entity]),
      ),
    [mentionEntities],
  )
  const channelCandidates = useMemo(
    () =>
      channelMentionTargets
        .flatMap((target): Array<{ name: string; value: ChannelMentionTarget }> => [
          { name: target.name, value: target },
          { name: target.scopedSlug, value: target },
        ])
        .sort((left, right) => right.name.length - left.name.length),
    [channelMentionTargets],
  )
  const channelLabelCandidates = useMemo(() => {
    const byLabel = new Map<string, { name: string; value: ChannelMentionTarget[] }>()
    for (const target of channelMentionTargets) {
      const existing = byLabel.get(target.labelKey)
      if (existing) {
        existing.value.push(target)
      } else {
        byLabel.set(target.labelKey, {
          name: target.channel.label,
          value: [target],
        })
      }
    }
    return [...byLabel.values()].sort((left, right) => right.name.length - left.name.length)
  }, [channelMentionTargets])
  const dmChannelByUserId = useMemo(
    () =>
      new Map(
        channelUsers
          .map((user): [string, ChannelRecord | undefined] => [
            user.id,
            channels.find(
              (channel) =>
                isUserDmChannel(channel) && user.channelIds.includes(channel.id),
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
  const presenceMentionMap = useMemo(
    () =>
      new Map(
        [...personalAssistantPresences]
          // If two entries have the same public token, keep the viewer's own
          // projection when available. The persisted entity still carries the
          // pair of ids; this map is only content rendering.
          .sort((left, right) =>
            Number(left.displayName === 'Personal Assistant')
            - Number(right.displayName === 'Personal Assistant'))
          .map((presence) => [
          presence.mentionName,
          presence.displayName,
          ]),
      ),
    [personalAssistantPresences],
  )
  const sortedPresenceMentionNames = useMemo(
    () => [...presenceMentionMap.keys()].sort((left, right) => right.length - left.length),
    [presenceMentionMap],
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

          const bareChannelMatch = findTokenMatch(
            text,
            trigger.index + 1,
            channelLabelCandidates,
          )

          if (bareChannelMatch) {
            const activeProjectMatches = activeChannel
              ? bareChannelMatch.value.filter(
                  (target) => target.channel.projectId === activeChannel.projectId,
                )
              : []
            const resolvedTarget =
              bareChannelMatch.value.length === 1
                ? bareChannelMatch.value[0]
                : activeProjectMatches.length === 1
                  ? activeProjectMatches[0]
                  : undefined

            if (trigger.index > cursor) {
              parts.push(text.slice(cursor, trigger.index))
            }

            if (resolvedTarget) {
              parts.push(
                <Link
                  className="mention-tag mention-tag-link"
                  key={`channel:${resolvedTarget.channel.id}:${trigger.index}`}
                  title={`Open #${resolvedTarget.channel.label} in ${resolvedTarget.detail}`}
                  to={`/channels/${resolvedTarget.channel.id}`}
                >
                  #{bareChannelMatch.text}
                </Link>,
              )
            } else {
              const query = encodeURIComponent(bareChannelMatch.text)
              parts.push(
                <Link
                  className="mention-tag mention-tag-link"
                  key={`channel-search:${normalizeChannelLabel(bareChannelMatch.text)}:${trigger.index}`}
                  title={`Find #${bareChannelMatch.text} (${bareChannelMatch.value.length} matches)`}
                  to={`/search?query=${query}`}
                >
                  #{bareChannelMatch.text}
                </Link>,
              )
            }

            cursor = trigger.index + 1 + bareChannelMatch.name.length
            continue
          }

          parts.push(text.slice(cursor, trigger.index + 1))
          cursor = trigger.index + 1
          continue
        }

        const presenceMentionName = findTokenName(
          text,
          trigger.index + 1,
          sortedPresenceMentionNames,
        )
        if (presenceMentionName) {
          if (trigger.index > cursor) {
            parts.push(text.slice(cursor, trigger.index))
          }
          parts.push(
            <span
              className="mention-tag"
              key={`personal-assistant:${presenceMentionName}:${trigger.index}`}
            >
              @{presenceMentionMap.get(presenceMentionName) ?? presenceMentionName}
            </span>,
          )
          cursor = trigger.index + 1 + presenceMentionName.length
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
            <button
              className="mention-tag mention-tag-link"
              key={`${entity.id}:${trigger.index}`}
              onClick={(event) => {
                event.stopPropagation()
                navigateToAgentDm(entity.id)
              }}
              title={`Message ${entity.name}`}
              type="button"
            >
              @{entityName}
            </button>
          ) : (
            <Link
              className="mention-tag mention-tag-link"
              key={`${entity.id}:${trigger.index}`}
              title={
                dmChannel
                  ? `Open chat with ${entity.name}`
                  : `Open ${entity.name} in team users`
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
      channelLabelCandidates,
      dmChannelByUserId,
      mentionEntityMap,
      navigateToAgentDm,
      presenceMentionMap,
      activeChannel,
      sortedMentionNames,
      sortedPresenceMentionNames,
    ],
  )

  return { mentionEntities, renderContent }
}
