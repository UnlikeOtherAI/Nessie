import { Suspense, lazy, type CSSProperties } from 'react'
import type { EmojiClickData, EmojiStyle, SkinTones, Theme } from 'emoji-picker-react'
import { getCookie, setCookie } from '../../lib/storage'

const FullEmojiPicker = lazy(() => import('emoji-picker-react'))
const SKIN_TONE_COOKIE = 'emojiSkinTone'
const NEUTRAL_SKIN_TONE = 'neutral' as SkinTones
const skinToneValues = new Set(['neutral', '1f3fb', '1f3fc', '1f3fd', '1f3fe', '1f3ff'])

type EmojiPickerThemeStyle = CSSProperties & Record<`--${string}`, string>

const emojiPickerThemeStyle: EmojiPickerThemeStyle = {
  '--epr-active-skin-hover-color': 'var(--accent-soft)',
  '--epr-category-icon-active-color': 'var(--accent)',
  '--epr-category-label-bg-color': 'color-mix(in srgb, var(--panel) 94%, transparent)',
  '--epr-category-label-text-color': 'var(--tx3)',
  '--epr-emoji-hover-color': 'var(--overlay)',
  '--epr-emoji-variation-indicator-color': 'var(--sep)',
  '--epr-emoji-variation-indicator-color-hover': 'var(--tx2)',
  '--epr-emoji-variation-picker-bg-color': 'var(--panel)',
  '--epr-focus-bg-color': 'var(--accent-soft)',
  '--epr-highlight-color': 'var(--accent)',
  '--epr-hover-bg-color': 'var(--overlay)',
  '--epr-hover-bg-color-reduced-opacity': 'var(--overlay-weak)',
  '--epr-picker-border-color': 'var(--sep)',
  '--epr-picker-border-radius': '8px',
  '--epr-preview-border-color': 'var(--sep)',
  '--epr-preview-text-color': 'var(--tx2)',
  '--epr-reactions-bg-color': 'color-mix(in srgb, var(--panel) 92%, transparent)',
  '--epr-search-border-color': 'var(--sep)',
  '--epr-search-border-color-active': 'var(--accent)',
  '--epr-search-input-bg-color': 'var(--main)',
  '--epr-search-input-bg-color-active': 'var(--main-hover)',
  '--epr-search-input-placeholder-color': 'var(--tx3)',
  '--epr-search-input-text-color': 'var(--tx)',
  '--epr-skin-tone-inner-border-color': 'var(--panel)',
  '--epr-skin-tone-outer-border-color': 'var(--sep)',
  '--epr-skin-tone-picker-menu-color': 'color-mix(in srgb, var(--panel) 96%, transparent)',
  '--epr-text-color': 'var(--tx2)',
  '--epr-bg-color': 'var(--panel)',
}

type EmojiPickerPanelProps = {
  onSelect: (value: string) => void
}

const readStoredSkinTone = (): SkinTones => {
  const stored = getCookie(SKIN_TONE_COOKIE)
  return stored && skinToneValues.has(stored) ? (stored as SkinTones) : NEUTRAL_SKIN_TONE
}

export const EmojiPickerPanel = ({ onSelect }: EmojiPickerPanelProps) => {
  const defaultSkinTone = readStoredSkinTone()

  const pickEmoji = (emojiData: EmojiClickData) => {
    setCookie(SKIN_TONE_COOKIE, emojiData.activeSkinTone)
    onSelect(emojiData.emoji)
  }

  const storeSkinTone = (skinTone: SkinTones) => {
    setCookie(SKIN_TONE_COOKIE, skinTone)
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center text-sm text-[color:var(--tx3)]">
          Loading emojis...
        </div>
      }
    >
      <FullEmojiPicker
        autoFocusSearch
        defaultSkinTone={defaultSkinTone}
        emojiStyle={'native' as EmojiStyle}
        height={360}
        lazyLoadEmojis
        onEmojiClick={pickEmoji}
        onSkinToneChange={storeSkinTone}
        previewConfig={{ showPreview: false }}
        searchPlaceholder="Search emojis"
        style={emojiPickerThemeStyle}
        theme={'light' as Theme}
        width="100%"
      />
    </Suspense>
  )
}
