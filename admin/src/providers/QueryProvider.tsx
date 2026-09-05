import type { PropsWithChildren } from 'react'
import { createQueryClient, QueryProvider as BaseQueryProvider } from '@nessie/client-core'
import { formErrorMessage } from '../facades/forms/form-errors'
import { notifyMutationError } from './ToastProvider'

/**
 * The admin's own `QueryClient`: `@nessie/client-core`'s standard
 * query/mutation defaults, plus a mutation error default that surfaces a
 * failure nobody wired an `onError` for as a toast — 43 of 144
 * mutation-bearing components had no error surface at all before this
 * existed (docs/plans/2026-09-01-content-design-system/overview.md §4.5).
 * `ToastProvider` mounts well below this (`layouts/AdminShellLayout.tsx`,
 * inside the router `QueryProvider` wraps), so the handler goes through the
 * module-level sink `ToastProvider` registers on mount rather than through
 * context.
 */
const adminQueryClient = createQueryClient({
  onMutationError: (error) => {
    notifyMutationError(formErrorMessage(error, 'Something went wrong'))
  },
})

export const QueryProvider = ({ children }: PropsWithChildren) => (
  <BaseQueryProvider client={adminQueryClient}>{children}</BaseQueryProvider>
)
