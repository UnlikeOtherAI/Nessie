import enGBAccountMenu from './locales/en-GB/accountMenu.json'
import enGBShell from './locales/en-GB/shell.json'
import enGBProjects from './locales/en-GB/projects.json'
import enGBSettings from './locales/en-GB/settings.json'
import enGBNativeShell from './locales/en-GB/nativeShell.json'
import enGBCommon from './locales/en-GB/common.json'
import enGBFeedback from './locales/en-GB/feedback.json'
import enGBChannels from './locales/en-GB/channels.json'
import enUSAccountMenu from './locales/en-US/accountMenu.json'
import enUSShell from './locales/en-US/shell.json'
import enUSProjects from './locales/en-US/projects.json'
import enUSSettings from './locales/en-US/settings.json'
import enUSNativeShell from './locales/en-US/nativeShell.json'
import enUSCommon from './locales/en-US/common.json'
import enUSFeedback from './locales/en-US/feedback.json'
import enUSChannels from './locales/en-US/channels.json'
import csAccountMenu from './locales/cs/accountMenu.json'
import csShell from './locales/cs/shell.json'
import csProjects from './locales/cs/projects.json'
import csSettings from './locales/cs/settings.json'
import csNativeShell from './locales/cs/nativeShell.json'
import csCommon from './locales/cs/common.json'
import csFeedback from './locales/cs/feedback.json'
import csChannels from './locales/cs/channels.json'
import deAccountMenu from './locales/de/accountMenu.json'
import deShell from './locales/de/shell.json'
import deProjects from './locales/de/projects.json'
import deSettings from './locales/de/settings.json'
import deNativeShell from './locales/de/nativeShell.json'
import deCommon from './locales/de/common.json'
import deFeedback from './locales/de/feedback.json'
import deChannels from './locales/de/channels.json'
import frAccountMenu from './locales/fr/accountMenu.json'
import frShell from './locales/fr/shell.json'
import frProjects from './locales/fr/projects.json'
import frSettings from './locales/fr/settings.json'
import frNativeShell from './locales/fr/nativeShell.json'
import frCommon from './locales/fr/common.json'
import frFeedback from './locales/fr/feedback.json'
import frChannels from './locales/fr/channels.json'
import itAccountMenu from './locales/it/accountMenu.json'
import itShell from './locales/it/shell.json'
import itProjects from './locales/it/projects.json'
import itSettings from './locales/it/settings.json'
import itNativeShell from './locales/it/nativeShell.json'
import itCommon from './locales/it/common.json'
import itFeedback from './locales/it/feedback.json'
import itChannels from './locales/it/channels.json'
import esAccountMenu from './locales/es/accountMenu.json'
import esShell from './locales/es/shell.json'
import esProjects from './locales/es/projects.json'
import esSettings from './locales/es/settings.json'
import esNativeShell from './locales/es/nativeShell.json'
import esCommon from './locales/es/common.json'
import esFeedback from './locales/es/feedback.json'
import esChannels from './locales/es/channels.json'
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
    channels: enGBChannels,
  },
  'en-US': {
    accountMenu: enUSAccountMenu,
    shell: enUSShell,
    projects: enUSProjects,
    settings: enUSSettings,
    nativeShell: enUSNativeShell,
    common: enUSCommon,
    feedback: enUSFeedback,
    channels: enUSChannels,
  },
  'cs': {
    accountMenu: csAccountMenu,
    shell: csShell,
    projects: csProjects,
    settings: csSettings,
    nativeShell: csNativeShell,
    common: csCommon,
    feedback: csFeedback,
    channels: csChannels,
  },
  'de': {
    accountMenu: deAccountMenu,
    shell: deShell,
    projects: deProjects,
    settings: deSettings,
    nativeShell: deNativeShell,
    common: deCommon,
    feedback: deFeedback,
    channels: deChannels,
  },
  'fr': {
    accountMenu: frAccountMenu,
    shell: frShell,
    projects: frProjects,
    settings: frSettings,
    nativeShell: frNativeShell,
    common: frCommon,
    feedback: frFeedback,
    channels: frChannels,
  },
  'it': {
    accountMenu: itAccountMenu,
    shell: itShell,
    projects: itProjects,
    settings: itSettings,
    nativeShell: itNativeShell,
    common: itCommon,
    feedback: itFeedback,
    channels: itChannels,
  },
  'es': {
    accountMenu: esAccountMenu,
    shell: esShell,
    projects: esProjects,
    settings: esSettings,
    nativeShell: esNativeShell,
    common: esCommon,
    feedback: esFeedback,
    channels: esChannels,
  },
} satisfies Record<Language, Record<TranslationNamespace, unknown>>

export { translationNamespaces }
