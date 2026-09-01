import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useRedirect } from '../../navigation/redirect'
import { useMessageSearch } from '../../facades/messages/hooks'

/**
 * Owns the channel message-search dropdown's local state (open/query) and the
 * jump-to-message scroll behaviour, including the alert deep-link highlight
 * (useAlertMessageHighlight). Split out of ChannelsPage so that page
 * stays focused on composing the channel surfaces rather than one feature's
 * state machine.
 */
export const useChannelMessageSearch = (activeChannelId?: string) => {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const { data: searchResults = [] } = useMessageSearch(activeChannelId, searchQuery)

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      if (open) {
        setSearchQuery('')
      }
      return !open
    })
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [])

  const jumpToMessage = useCallback((messageId: string) => {
    const element = document.getElementById(`msg-${messageId}`)
    if (!element) {
      return
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.classList.add('admin-msg-highlight')
    window.setTimeout(() => element.classList.remove('admin-msg-highlight'), 1600)
  }, [])

  return {
    closeSearch,
    jumpToMessage,
    searchOpen,
    searchQuery,
    searchResults,
    setSearchQuery,
    toggleSearch,
  }
}

/**
 * Consumes alert deep-links: clicking an alert navigates to the channel with
 * `{ highlightMessageId }` in location state. Once the feed has loaded at
 * least once, scroll + highlight the message via the same jump behaviour the
 * channel search uses (a no-op when the message isn't in the loaded window),
 * then clear the state so a refresh doesn't re-trigger the jump.
 */
export const useAlertMessageHighlight = (
  messagesLoaded: boolean,
  jumpToMessage: (messageId: string) => void,
) => {
  const location = useLocation()
  const redirect = useRedirect()
  const alertMessageId = (
    location.state as { highlightMessageId?: unknown } | null
  )?.highlightMessageId
  const messageIdFromPush = new URLSearchParams(location.search).get('messageId')
  const highlightMessageId = typeof alertMessageId === 'string'
    ? alertMessageId
    : messageIdFromPush

  useEffect(() => {
    if (typeof highlightMessageId !== 'string' || !highlightMessageId || !messagesLoaded) {
      return
    }
    jumpToMessage(highlightMessageId)
    const search = new URLSearchParams(location.search)
    search.delete('messageId')
    redirect({ pathname: location.pathname, search: search.size > 0 ? `?${search.toString()}` : '' })
  }, [highlightMessageId, jumpToMessage, location.pathname, location.search, messagesLoaded, redirect])
}
