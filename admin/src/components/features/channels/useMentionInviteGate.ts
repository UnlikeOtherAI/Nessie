import { useCallback, useMemo, useState } from 'react'

import {
  useAddChannelMember,
  useChannelMentionAudienceCheck,
} from '../../../facades/channels/hooks'
import { useUsers } from '../../../facades/users/hooks'
import type { ChannelRecord, UserRecord } from '../../../lib/api-client'
import type { AgentMention } from '../../shared/MentionInput'
import { channelMayAskToInvite, findMentionedNonMemberIds } from './mention-invite'

/**
 * The invite-before-send question (docs/standards/user-alerts.md → "Who a
 * mention can address").
 *
 * A draft that @mentions somebody who cannot read a private or protected
 * channel stops before it is sent, and the author chooses: invite them through
 * the ordinary member write, then send; or send without inviting, in which case
 * the server addresses nobody outside the channel. Public channels, DMs and
 * system conversations never ask — the server says so, and the client skips
 * DMs and system conversations only to save the round trip.
 */
export type MentionInvitePrompt = {
  agentMentions: AgentMention[]
  canInvite: boolean
  channelLabel: string
  outsiders: UserRecord[]
  text: string
}

export type MentionInviteController = {
  prompt: MentionInvitePrompt | null
  pending: boolean
  error: string | null
  onInviteAndSend: () => void
  onSendWithoutInviting: () => void
  onCancel: () => void
}

type Deliver = (text: string, agentMentions: AgentMention[]) => Promise<void>

export const useMentionInviteGate = (input: {
  activeChannel: ChannelRecord | null
  currentUserId: string | undefined
  deliver: Deliver
  restoreDraft: (text: string) => void
}) => {
  const { activeChannel, currentUserId, deliver, restoreDraft } = input
  const { data: users = [] } = useUsers()
  const checkAudience = useChannelMentionAudienceCheck()
  const addMember = useAddChannelMember()
  const [prompt, setPrompt] = useState<MentionInvitePrompt | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Resolves `true` when the send may go ahead now, `false` when it was held
   * for the question (or the check failed and the draft was put back).
   */
  const clearToSend = useCallback(
    async (text: string, agentMentions: AgentMention[]): Promise<boolean> => {
      if (!channelMayAskToInvite(activeChannel)) return true
      const candidateIds = findMentionedNonMemberIds(text, users, {
        channelId: activeChannel.id,
        currentUserId,
      })
      if (candidateIds.length === 0) return true
      try {
        const audience = await checkAudience(activeChannel.id, candidateIds)
        if (audience.outsiderUserIds.length === 0) return true
        const byId = new Map(users.map((user) => [user.id, user]))
        setError(null)
        setPrompt({
          agentMentions,
          canInvite: audience.viewerCanAddMembers,
          channelLabel: activeChannel.label,
          outsiders: audience.outsiderUserIds.flatMap((id) => byId.get(id) ?? []),
          text,
        })
      } catch {
        // Unanswered is not "nobody": put the draft back rather than guess.
        restoreDraft(text)
        throw new Error('Could not check who can see this conversation. Please try again.')
      }
      restoreDraft(text)
      return false
    },
    [activeChannel, checkAudience, currentUserId, restoreDraft, users],
  )

  const send = useCallback(
    async (held: MentionInvitePrompt) => {
      setPrompt(null)
      setError(null)
      await deliver(held.text, held.agentMentions)
    },
    [deliver],
  )

  const onInviteAndSend = useCallback(() => {
    const held = prompt
    if (!held || !activeChannel || !held.canInvite || pending) return
    setPending(true)
    setError(null)
    void (async () => {
      const failed: string[] = []
      for (const person of held.outsiders) {
        try {
          await addMember.mutateAsync({ channelId: activeChannel.id, userId: person.id })
        } catch {
          failed.push(person.displayName)
        }
      }
      setPending(false)
      if (failed.length > 0) {
        setError(
          `Could not add ${failed.join(', ')}. You can try again or send without inviting.`,
        )
        return
      }
      await send(held)
    })()
  }, [activeChannel, addMember, pending, prompt, send])

  const onSendWithoutInviting = useCallback(() => {
    if (prompt && !pending) void send(prompt)
  }, [pending, prompt, send])

  const onCancel = useCallback(() => {
    if (pending) return
    setPrompt(null)
    setError(null)
  }, [pending])

  const controller = useMemo<MentionInviteController>(
    () => ({ error, onCancel, onInviteAndSend, onSendWithoutInviting, pending, prompt }),
    [error, onCancel, onInviteAndSend, onSendWithoutInviting, pending, prompt],
  )

  return { clearToSend, controller }
}
