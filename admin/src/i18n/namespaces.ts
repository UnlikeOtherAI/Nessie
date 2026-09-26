/** Feature-owned catalogs loaded by the shared i18next instance. */
export const translationNamespaces = [
  'accountMenu', 'shell', 'projects', 'settings', 'nativeShell', 'common', 'feedback', 'inbox',
] as const

export type TranslationNamespace = (typeof translationNamespaces)[number]
