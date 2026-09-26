/** Feature-owned catalogs loaded by the shared i18next instance. */
export const translationNamespaces = [
  'accountMenu', 'shell', 'projects', 'settings', 'nativeShell', 'common', 'feedback', 'inbox',
  'auth', 'search', 'knowledgeFinder', 'channels', 'agentConversations', 'opsBudget',
] as const

export type TranslationNamespace = (typeof translationNamespaces)[number]
