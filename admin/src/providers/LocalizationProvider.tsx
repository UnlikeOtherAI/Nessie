import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type PropsWithChildren } from 'react'
import { useTranslation } from 'react-i18next'
import { useUpdatePreferences } from '../facades/auth/hooks'
import { DEFAULT_LANGUAGE, isLanguage, type Language } from '../i18n/languages'
import i18n, { LANGUAGE_STORAGE_KEY } from '../i18n/i18n'
import { useAuthSession } from './AuthSessionProvider'

type LocalizationValue = { language: Language; setLanguage: (language: Language) => void }
const LocalizationContext = createContext<LocalizationValue | null>(null)

const storeLanguage = (language: Language): void => {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Language still applies for this session when storage is unavailable.
  }
}

export const LocalizationProvider = ({ children }: PropsWithChildren) => {
  const { me } = useAuthSession()
  const { mutate: updatePreferences } = useUpdatePreferences()
  const { i18n: activeI18n } = useTranslation()
  const savedLanguage = me?.user.preferences?.language
  const language = isLanguage(activeI18n.language) ? activeI18n.language : DEFAULT_LANGUAGE
  const selectionRevision = useRef(0)
  const pendingLanguage = useRef<Language | null>(null)

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  useEffect(() => {
    if (pendingLanguage.current && savedLanguage !== pendingLanguage.current) return
    if (pendingLanguage.current === savedLanguage) pendingLanguage.current = null
    if (isLanguage(savedLanguage) && activeI18n.language !== savedLanguage) {
      void activeI18n.changeLanguage(savedLanguage)
      storeLanguage(savedLanguage)
    }
  }, [activeI18n, savedLanguage])

  const setLanguage = useCallback((next: Language) => {
    if (next === language) return
    const previous = language
    const revision = ++selectionRevision.current
    pendingLanguage.current = me ? next : null
    storeLanguage(next)
    void i18n.changeLanguage(next)
    if (me) {
      updatePreferences({ language: next }, {
        onError: () => {
          if (selectionRevision.current !== revision) return
          pendingLanguage.current = null
          storeLanguage(previous)
          void i18n.changeLanguage(previous)
        },
      })
    }
  }, [language, me, updatePreferences])

  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage])
  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>
}

export const useLocalization = (): LocalizationValue => {
  const context = useContext(LocalizationContext)
  if (!context) throw new Error('useLocalization must be used within LocalizationProvider')
  return context
}
