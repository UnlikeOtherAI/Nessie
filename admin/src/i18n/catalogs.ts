import enGBAccountMenu from './locales/en-GB/accountMenu.json'
import enGBShell from './locales/en-GB/shell.json'
import enGBProjects from './locales/en-GB/projects.json'
import enGBSettings from './locales/en-GB/settings.json'
import enGBNativeShell from './locales/en-GB/nativeShell.json'
import enGBCommon from './locales/en-GB/common.json'
import enGBFeedback from './locales/en-GB/feedback.json'
import enGBInbox from './locales/en-GB/inbox.json'
import enGBSearch from './locales/en-GB/search.json'
import enGBKnowledgeFinder from './locales/en-GB/knowledgeFinder.json'
import enUSAccountMenu from './locales/en-US/accountMenu.json'
import enUSShell from './locales/en-US/shell.json'
import enUSProjects from './locales/en-US/projects.json'
import enUSSettings from './locales/en-US/settings.json'
import enUSNativeShell from './locales/en-US/nativeShell.json'
import enUSCommon from './locales/en-US/common.json'
import enUSFeedback from './locales/en-US/feedback.json'
import enUSInbox from './locales/en-US/inbox.json'
import enUSSearch from './locales/en-US/search.json'
import enUSKnowledgeFinder from './locales/en-US/knowledgeFinder.json'
import csAccountMenu from './locales/cs/accountMenu.json'
import csShell from './locales/cs/shell.json'
import csProjects from './locales/cs/projects.json'
import csSettings from './locales/cs/settings.json'
import csNativeShell from './locales/cs/nativeShell.json'
import csCommon from './locales/cs/common.json'
import csFeedback from './locales/cs/feedback.json'
import csInbox from './locales/cs/inbox.json'
import csSearch from './locales/cs/search.json'
import csKnowledgeFinder from './locales/cs/knowledgeFinder.json'
import deAccountMenu from './locales/de/accountMenu.json'
import deShell from './locales/de/shell.json'
import deProjects from './locales/de/projects.json'
import deSettings from './locales/de/settings.json'
import deNativeShell from './locales/de/nativeShell.json'
import deCommon from './locales/de/common.json'
import deFeedback from './locales/de/feedback.json'
import deInbox from './locales/de/inbox.json'
import deSearch from './locales/de/search.json'
import deKnowledgeFinder from './locales/de/knowledgeFinder.json'
import frAccountMenu from './locales/fr/accountMenu.json'
import frShell from './locales/fr/shell.json'
import frProjects from './locales/fr/projects.json'
import frSettings from './locales/fr/settings.json'
import frNativeShell from './locales/fr/nativeShell.json'
import frCommon from './locales/fr/common.json'
import frFeedback from './locales/fr/feedback.json'
import frInbox from './locales/fr/inbox.json'
import frSearch from './locales/fr/search.json'
import frKnowledgeFinder from './locales/fr/knowledgeFinder.json'
import itAccountMenu from './locales/it/accountMenu.json'
import itShell from './locales/it/shell.json'
import itProjects from './locales/it/projects.json'
import itSettings from './locales/it/settings.json'
import itNativeShell from './locales/it/nativeShell.json'
import itCommon from './locales/it/common.json'
import itFeedback from './locales/it/feedback.json'
import itInbox from './locales/it/inbox.json'
import itSearch from './locales/it/search.json'
import itKnowledgeFinder from './locales/it/knowledgeFinder.json'
import esAccountMenu from './locales/es/accountMenu.json'
import esShell from './locales/es/shell.json'
import esProjects from './locales/es/projects.json'
import esSettings from './locales/es/settings.json'
import esNativeShell from './locales/es/nativeShell.json'
import esCommon from './locales/es/common.json'
import esFeedback from './locales/es/feedback.json'
import esInbox from './locales/es/inbox.json'
import esSearch from './locales/es/search.json'
import esKnowledgeFinder from './locales/es/knowledgeFinder.json'
import type { Language } from './languages'
import { translationNamespaces, type TranslationNamespace } from './namespaces'

export const catalogs = {
  'en-GB': {
    accountMenu: enGBAccountMenu,
    shell: enGBShell,
    projects: enGBProjects,
    settings: enGBSettings,
    nativeShell: enGBNativeShell,
    common: enGBCommon,
    feedback: enGBFeedback,
    inbox: enGBInbox,
    search: enGBSearch,
    knowledgeFinder: enGBKnowledgeFinder,
  },
  'en-US': {
    accountMenu: enUSAccountMenu,
    shell: enUSShell,
    projects: enUSProjects,
    settings: enUSSettings,
    nativeShell: enUSNativeShell,
    common: enUSCommon,
    feedback: enUSFeedback,
    inbox: enUSInbox,
    search: enUSSearch,
    knowledgeFinder: enUSKnowledgeFinder,
  },
  'cs': {
    accountMenu: csAccountMenu,
    shell: csShell,
    projects: csProjects,
    settings: csSettings,
    nativeShell: csNativeShell,
    common: csCommon,
    feedback: csFeedback,
    inbox: csInbox,
    search: csSearch,
    knowledgeFinder: csKnowledgeFinder,
  },
  'de': {
    accountMenu: deAccountMenu,
    shell: deShell,
    projects: deProjects,
    settings: deSettings,
    nativeShell: deNativeShell,
    common: deCommon,
    feedback: deFeedback,
    inbox: deInbox,
    search: deSearch,
    knowledgeFinder: deKnowledgeFinder,
  },
  'fr': {
    accountMenu: frAccountMenu,
    shell: frShell,
    projects: frProjects,
    settings: frSettings,
    nativeShell: frNativeShell,
    common: frCommon,
    feedback: frFeedback,
    inbox: frInbox,
    search: frSearch,
    knowledgeFinder: frKnowledgeFinder,
  },
  'it': {
    accountMenu: itAccountMenu,
    shell: itShell,
    projects: itProjects,
    settings: itSettings,
    nativeShell: itNativeShell,
    common: itCommon,
    feedback: itFeedback,
    inbox: itInbox,
    search: itSearch,
    knowledgeFinder: itKnowledgeFinder,
  },
  'es': {
    accountMenu: esAccountMenu,
    shell: esShell,
    projects: esProjects,
    settings: esSettings,
    nativeShell: esNativeShell,
    common: esCommon,
    feedback: esFeedback,
    inbox: esInbox,
    search: esSearch,
    knowledgeFinder: esKnowledgeFinder,
  },
} satisfies Record<Language, Record<TranslationNamespace, unknown>>

export { translationNamespaces }
