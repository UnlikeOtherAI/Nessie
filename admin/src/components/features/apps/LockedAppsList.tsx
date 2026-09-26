import { useEffect } from 'react'

import { useAppShelfPages } from '../../../facades/apps/hooks'
import { SectionLabel } from '../../primitives/SectionLabel'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { AppIcon } from './AppIcon'
import { appDetailHref } from './app-card-presentation'

const stillConnected = (count: number): string | undefined =>
  count === 0 ? undefined : `${count} ${count === 1 ? 'account' : 'accounts'} still connected`

/**
 * The organisation's locked apps, among those connected here: members can no
 * longer add them, and the accounts already connected keep working until
 * somebody removes them (`setCatalogEntryLocked`). Read-only — a lock is set on
 * an app's own page, which gains its Lock control in a later phase.
 *
 * Read from the catalogue's Installed view, the one list that reports a lock
 * and can be read whole. The full catalogue runs to thousands of apps and no
 * read narrows it to the locked ones, so a locked app nobody here has
 * connected is not listed — and the lede says so rather than implying this is
 * every lock.
 */
export const LockedAppsList = () => {
  const installed = useAppShelfPages({ category: null, enabled: true, installed: true })
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = installed
  // Bounded by what the organisation has connected — tens of apps — so it is
  // read to the end rather than paged on screen.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  const complete = installed.isSuccess && !hasNextPage
  const locked = (installed.data?.pages ?? [])
    .flatMap((page) => page.apps)
    .filter((app) => app.locked)

  return (
    <section aria-label="Locked apps" className="grid gap-3">
      <div>
        <SectionLabel as="h2">Locked apps</SectionLabel>
        <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
          Apps connected here that members can no longer add. Accounts already connected keep
          working. An app nobody here has connected is not listed.
        </p>
      </div>
      <QueryState
        className="py-4"
        emptyLabel="None of the apps connected here is locked."
        errorLabel="Apps could not be loaded."
        isEmpty={complete && locked.length === 0}
        loadingLabel="Loading apps…"
        query={installed}
      >
        {() => complete ? (
          <RowList label="Locked apps">
            {locked.map((app) => (
              <Row
                href={appDetailHref(app)}
                key={app.id}
                leading={<AppIcon displayName={app.displayName} iconUrl={app.iconUrl} size={32} />}
                subtitle={stillConnected(app.connectionCount)}
                title={app.displayName}
              />
            ))}
          </RowList>
        ) : (
          <p className="py-4 text-center text-sm text-[color:var(--tx3)]">Loading apps…</p>
        )}
      </QueryState>
    </section>
  )
}
