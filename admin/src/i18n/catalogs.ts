import enGB from './locales/en-GB/accountMenu.json'
import enUS from './locales/en-US/accountMenu.json'
import cs from './locales/cs/accountMenu.json'
import de from './locales/de/accountMenu.json'
import fr from './locales/fr/accountMenu.json'
import it from './locales/it/accountMenu.json'
import es from './locales/es/accountMenu.json'
import type { Language } from './languages'
import { translationNamespaces } from './namespaces'

export const catalogs = {
  'en-GB': { accountMenu: enGB },
  'en-US': { accountMenu: enUS },
  cs: { accountMenu: cs },
  de: { accountMenu: de },
  fr: { accountMenu: fr },
  it: { accountMenu: it },
  es: { accountMenu: es },
} satisfies Record<Language, { accountMenu: typeof enGB }>

export { translationNamespaces }
