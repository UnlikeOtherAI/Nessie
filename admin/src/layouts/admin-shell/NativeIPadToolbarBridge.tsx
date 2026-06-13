import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import {
  RecentChannelsMenu,
  useHistoryNav,
  useRecordRecentChannelVisits,
} from './topbar-navigation'

type NativeToolbarAction = 'back' | 'forward' | 'history' | 'help'

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieToolbarAction?: (action: NativeToolbarAction) => void
}

const postToolbarState = (canBack: boolean, canForward: boolean, recentOpen: boolean) => {
  if (!isReactNativeWebView()) return
  const rnWindow = window as RnWindow
  rnWindow.ReactNativeWebView?.postMessage(
    JSON.stringify({
      type: 'nessie:toolbar-state',
      canBack,
      canForward,
      recentOpen,
    }),
  )
}

export const NativeIPadToolbarBridge = () => {
  const navigate = useNavigate()
  const menuRef = useRef<HTMLDivElement>(null)
  const { goBack, goForward, canBack, canForward } = useHistoryNav()
  const [recentOpen, setRecentOpen] = useState(false)

  useRecordRecentChannelVisits()

  useEffect(() => {
    if (!recentOpen) return undefined
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setRecentOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [recentOpen])

  useEffect(() => {
    if (!isReactNativeWebView()) return undefined
    const target = window as RnWindow
    target.__nessieToolbarAction = (action: NativeToolbarAction) => {
      if (action === 'back') {
        goBack()
      } else if (action === 'forward') {
        goForward()
      } else if (action === 'history') {
        setRecentOpen((open) => !open)
      } else if (action === 'help') {
        setRecentOpen(false)
        navigate('/feedback')
      }
    }
    return () => {
      delete target.__nessieToolbarAction
    }
  }, [goBack, goForward, navigate])

  useEffect(() => {
    postToolbarState(canBack, canForward, recentOpen)
  }, [canBack, canForward, recentOpen])

  return recentOpen ? (
    <div className="fixed right-3 top-3 z-[70]" ref={menuRef}>
      <RecentChannelsMenu
        className="admin-topbar-menu"
        onSelect={() => setRecentOpen(false)}
        style={{ left: 'auto', minWidth: 240, position: 'static' }}
      />
    </div>
  ) : null
}
