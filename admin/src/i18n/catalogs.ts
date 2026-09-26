import enGB from './locales/en-GB/accountMenu.json'
import enUS from './locales/en-US/accountMenu.json'
import cs from './locales/cs/accountMenu.json'
import de from './locales/de/accountMenu.json'
import fr from './locales/fr/accountMenu.json'
import it from './locales/it/accountMenu.json'
import es from './locales/es/accountMenu.json'
import enGBShell from './locales/en-GB/shell.json'
import enUSShell from './locales/en-US/shell.json'
import csShell from './locales/cs/shell.json'
import deShell from './locales/de/shell.json'
import frShell from './locales/fr/shell.json'
import itShell from './locales/it/shell.json'
import esShell from './locales/es/shell.json'
import enGBProjects from './locales/en-GB/projects.json'
import enUSProjects from './locales/en-US/projects.json'
import csProjects from './locales/cs/projects.json'
import deProjects from './locales/de/projects.json'
import frProjects from './locales/fr/projects.json'
import itProjects from './locales/it/projects.json'
import esProjects from './locales/es/projects.json'
import type { Language } from './languages'
import { translationNamespaces } from './namespaces'

export const catalogs = {
  'en-GB': { accountMenu: enGB, shell: enGBShell, projects: enGBProjects },
  'en-US': { accountMenu: enUS, shell: enUSShell, projects: enUSProjects },
  cs: { accountMenu: cs, shell: csShell, projects: csProjects },
  de: { accountMenu: de, shell: deShell, projects: deProjects },
  fr: { accountMenu: fr, shell: frShell, projects: frProjects },
  it: { accountMenu: it, shell: itShell, projects: itProjects },
  es: { accountMenu: es, shell: esShell, projects: esProjects },
} satisfies Record<Language, { accountMenu: typeof enGB; shell: typeof enGBShell; projects: typeof enGBProjects }>

export { translationNamespaces }
