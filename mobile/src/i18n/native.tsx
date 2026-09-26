import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, useContext } from 'react'

import enGB from './locales/en-GB/native.json'
import enUS from './locales/en-US/native.json'
import cs from './locales/cs/native.json'
import de from './locales/de/native.json'
import fr from './locales/fr/native.json'
import it from './locales/it/native.json'
import es from './locales/es/native.json'

export const NATIVE_LOCALE_STORAGE_KEY = 'nessie.native-language'
export const NATIVE_LOCALES = ['en-GB', 'en-US', 'cs', 'de', 'fr', 'it', 'es'] as const
export type NativeLocale = (typeof NATIVE_LOCALES)[number]
export type NativeCopy = typeof enGB

const catalogues: Record<NativeLocale, NativeCopy> = {
  'en-GB': enGB,
  'en-US': enUS,
  cs,
  de,
  fr,
  it,
  es,
}

export const isNativeLocale = (value: unknown): value is NativeLocale =>
  typeof value === 'string' && (NATIVE_LOCALES as readonly string[]).includes(value)

export const nativeCopyFor = (locale: NativeLocale): NativeCopy => catalogues[locale]

export const readNativeLocale = async (): Promise<NativeLocale> => {
  const stored = await AsyncStorage.getItem(NATIVE_LOCALE_STORAGE_KEY).catch(() => null)
  return isNativeLocale(stored) ? stored : 'en-GB'
}

export const persistNativeLocale = (locale: NativeLocale): void => {
  void AsyncStorage.setItem(NATIVE_LOCALE_STORAGE_KEY, locale).catch(() => undefined)
}

const NativeCopyContext = createContext<NativeCopy>(enGB)
export const NativeCopyProvider = NativeCopyContext.Provider
export const useNativeCopy = (): NativeCopy => useContext(NativeCopyContext)
