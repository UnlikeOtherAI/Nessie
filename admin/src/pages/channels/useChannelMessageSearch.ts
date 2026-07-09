import { useCallback, useState } from 'react'
import { useMessageSearch } from '../../facades/messages/hooks'

/**
 * Owns the channel message-search dropdown's local state (open/query) and the
 * jump-to-message scroll behaviour. Split out of ChannelsPage so that page
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
