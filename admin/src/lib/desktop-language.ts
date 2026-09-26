const DESKTOP_LOCALES = new Set(['en-GB', 'en-US', 'cs', 'de', 'fr', 'it', 'es'])

/** Read the selected admin locale when a native wrapper command is invoked. */
export const getDesktopLanguage = (): string => {
  try {
    const language = window.localStorage.getItem('nessie.language')
    return language && DESKTOP_LOCALES.has(language) ? language : 'en-GB'
  } catch {
    return 'en-GB'
  }
}
