/**
 * An agent's Documents home is *named* `${agentName} — Documents` by
 * `ensureAgentDocsSpace` (packages/knowledge/src/provisioning.ts), because the
 * name has to make sense everywhere a raw space name surfaces. In the browser
 * chrome — the root column's Agents section, the column header — the suffix is
 * furniture: the section label already says these are agents' documents, so
 * the row reads cleaner as the agent's name. Display-only: the space itself is
 * never renamed.
 */
const AGENT_DOCUMENTS_SUFFIX = ' — Documents'

export const agentDocumentsSpaceDisplayName = (spaceName: string): string =>
  spaceName.endsWith(AGENT_DOCUMENTS_SUFFIX)
    ? spaceName.slice(0, -AGENT_DOCUMENTS_SUFFIX.length)
    : spaceName
