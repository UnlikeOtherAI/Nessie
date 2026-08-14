import { DEFAULT_TOOLBAR_STATE, type ToolbarState } from './native-toolbar-state'
import { statusBarStyleForScheme } from '../lib/status-bar'
import { DEFAULT_BG, parseRgb } from '../lib/webview-inject'
import type { NativeShellMessage } from '../lib/native-shell-message'

type NativeAccount = {
  avatarUrl: string | null
  name: string | null
  presence: 'away' | 'offline' | 'online'
  statusEmoji: string | null
}

type AttentionBadges = {
  assignedWork: number
  channels: number
  knowledge: number
}

export type NativeShellPresentation = {
  accent: string
  attentionBadges: AttentionBadges
  background: string
  chromeSurface: string
  inactive: string
  nativeAccount: NativeAccount
  phoneHeaderSurface: string
  phoneHeaderText: string
  phoneOnAccent: string
  phoneText: string
  phoneTextMuted: string
  statusBarStyle: 'dark' | 'light'
  strongAccent: string
  toolbarState: ToolbarState
  workspaceAvatarUrl: string | null
  workspaceName: string | null
}

export const DEFAULT_NATIVE_SHELL_PRESENTATION: NativeShellPresentation = {
  accent: '#7c3aed',
  attentionBadges: { assignedWork: 0, channels: 0, knowledge: 0 },
  background: DEFAULT_BG,
  chromeSurface: '#222629',
  inactive: '#8a8f98',
  nativeAccount: { avatarUrl: null, name: null, presence: 'offline', statusEmoji: null },
  phoneHeaderSurface: '#2b2018',
  phoneHeaderText: '#fffdf8',
  phoneOnAccent: '#fffdf8',
  phoneText: '#2b2018',
  phoneTextMuted: '#74665b',
  statusBarStyle: 'light',
  strongAccent: '#5b21b6',
  toolbarState: DEFAULT_TOOLBAR_STATE,
  workspaceAvatarUrl: null,
  workspaceName: null,
}

const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const badgeCount = (value: unknown): number =>
  typeof value === 'number' && value > 0 ? Math.floor(value) : 0

const attentionBadges = (message: NativeShellMessage): AttentionBadges => ({
  assignedWork: badgeCount(message.assignedWork),
  channels: badgeCount(message.channels),
  knowledge: badgeCount(message.knowledge),
})

export const nativeAttentionTotal = (message: NativeShellMessage): number => {
  if (typeof message.total === 'number' && message.total >= 0) return message.total
  const badges = attentionBadges(message)
  return badges.channels + badges.assignedWork + badges.knowledge
}

export const isNativeShellPresentationMessage = (message: NativeShellMessage): boolean =>
  message.type === 'bg'
  || message.type === 'theme'
  || message.type === 'nessie:account'
  || message.type === 'nessie:attention'
  || message.type === 'nessie:toolbar-state'
  || message.type === 'nessie:workspace'

export const reduceNativeShellPresentation = (
  current: NativeShellPresentation,
  message: NativeShellMessage,
): NativeShellPresentation => {
  if (message.type === 'bg' && typeof message.color === 'string') {
    const rgb = parseRgb(message.color)
    return rgb && rgb[3] !== 0 ? { ...current, background: message.color } : current
  }
  if (message.type === 'theme') {
    return {
      ...current,
      accent: optionalText(message.accent) ?? current.accent,
      chromeSurface: optionalText(message.surface) ?? current.chromeSurface,
      inactive: optionalText(message.inactive) ?? current.inactive,
      phoneHeaderSurface: optionalText(message.headerSurface) ?? current.phoneHeaderSurface,
      phoneHeaderText: optionalText(message.headerText) ?? current.phoneHeaderText,
      phoneOnAccent: optionalText(message.onAccent) ?? current.phoneOnAccent,
      phoneText: optionalText(message.text) ?? current.phoneText,
      phoneTextMuted: optionalText(message.textMuted) ?? current.phoneTextMuted,
      statusBarStyle: statusBarStyleForScheme(message.scheme) ?? current.statusBarStyle,
      strongAccent: optionalText(message.accentStrong) ?? current.strongAccent,
    }
  }
  if (message.type === 'nessie:account') {
    return {
      ...current,
      nativeAccount: {
        avatarUrl: optionalText(message.userAvatarUrl),
        name: optionalText(message.userName),
        presence: message.userPresence === 'online' || message.userPresence === 'away'
          ? message.userPresence
          : 'offline',
        statusEmoji: optionalText(message.userStatusEmoji),
      },
    }
  }
  if (message.type === 'nessie:attention') {
    return { ...current, attentionBadges: attentionBadges(message) }
  }
  if (message.type === 'nessie:toolbar-state') {
    return {
      ...current,
      toolbarState: {
        canBack: Boolean(message.canBack),
        canForward: Boolean(message.canForward),
        recentOpen: Boolean(message.recentOpen),
      },
    }
  }
  if (message.type === 'nessie:workspace') {
    return {
      ...current,
      workspaceAvatarUrl: optionalText(message.workspaceAvatarUrl),
      workspaceName: optionalText(message.name),
    }
  }
  return current
}
