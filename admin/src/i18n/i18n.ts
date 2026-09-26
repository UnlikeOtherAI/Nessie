import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { catalogs } from './catalogs'
import { DEFAULT_LANGUAGE, isLanguage } from './languages'

export const LANGUAGE_STORAGE_KEY = 'nessie.language'

const readStoredLanguage = (): string | null => {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
  } catch {
    return null
  }
}

export const initializeLocalization = (): Promise<unknown> => {
  if (i18n.isInitialized) return Promise.resolve()
  const initial = readStoredLanguage()
  return i18n.use(initReactI18next).init({
    resources: catalogs,
    lng: isLanguage(initial) ? initial : DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    defaultNS: 'accountMenu',
    ns: ['accountMenu'],
    interpolation: { escapeValue: false },
    returnNull: false,
  })
}

export default i18n
