import type { Surface, SurfaceParent } from './page-types'

// Connected-mail routes live under the Admin stack, but form their own nested
// route family: account, message thread, and compose flow share the same Back
// destinations. Keeping that family together makes its stack rules explicit
// without turning the main registry into a second navigation mechanism.
export const createConnectedMailSurfaces = (adminRoot: string): Surface[] => {
  const toMail = (): SurfaceParent => ({ label: 'Back to Mail', pathname: '/mail' })

  return [
    {
      depth: 0,
      pattern: /^\/mail$/,
      root: adminRoot,
      section: 'admin',
      type: 'root',
    },
    {
      depth: 2,
      flowPresentation: 'screen',
      identityOf: (match) => `mail-compose:${match[1]}:${match[2]}`,
      intent: { state: ['draftId', 'reply', 'threadId'] },
      keyScope: () => 'mail-compose',
      parentOf: (match) => ({ label: 'Back to mail', pathname: `/mail/${match[1]}/${match[2]}` }),
      pattern: /^\/mail\/([^/]+)\/([^/]+)\/compose$/,
      root: adminRoot,
      section: 'admin',
      type: 'flow',
    },
    {
      depth: 2,
      identityOf: (match) => `mail:${match[1]}:${match[2]}:${match[3]}`,
      keyScope: () => 'mail-thread',
      parentOf: (match) => ({ label: 'Back to mail', pathname: `/mail/${match[1]}/${match[2]}` }),
      pattern: /^\/mail\/([^/]+)\/([^/]+)\/threads\/([^/]+)$/,
      root: adminRoot,
      section: 'admin',
      splitInline: true,
      type: 'nested',
    },
    {
      depth: 1,
      identityOf: (match) => `mail:${match[1]}:${match[2]}`,
      intent: { state: ['filter', 'pageSize'] },
      keyScope: () => 'mail-account',
      parentOf: toMail,
      pattern: /^\/mail\/([^/]+)\/([^/]+)$/,
      root: adminRoot,
      section: 'admin',
      type: 'detail',
    },
  ]
}
