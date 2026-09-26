export const LANGUAGES = [
  { code: 'en-GB', emoji: '🇬🇧', nativeName: 'English (UK)' },
  { code: 'en-US', emoji: '🇺🇸', nativeName: 'English (US)' },
  { code: 'cs', emoji: '🇨🇿', nativeName: 'Čeština' },
  { code: 'de', emoji: '🇩🇪', nativeName: 'Deutsch' },
  { code: 'fr', emoji: '🇫🇷', nativeName: 'Français' },
  { code: 'it', emoji: '🇮🇹', nativeName: 'Italiano' },
  { code: 'es', emoji: '🇪🇸', nativeName: 'Español' },
] as const

export type Language = (typeof LANGUAGES)[number]['code']
export const DEFAULT_LANGUAGE: Language = 'en-GB'

export const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && LANGUAGES.some((language) => language.code === value)
