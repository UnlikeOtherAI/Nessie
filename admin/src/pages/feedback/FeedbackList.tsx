import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UseQueryResult } from '@tanstack/react-query'
import { DEFAULT_PAGE_LIMIT, buildPageLabel } from '@nessie/schemas'
import { Card } from '../../components/shared/Card'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { QueryState } from '../../components/shared/QueryState'
import { Row, RowList } from '../../components/shared/RowList'
import { Pill } from '../../components/primitives/Pill'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import type { FeedbackRecord } from '../../lib/api-client'
import { feedbackStatusKey, feedbackStatusTone } from './feedback-presentation'

const formatDate = (iso: string, locale: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale)
}

export const getFeedbackPage = <Item,>(
  items: Item[],
  page: number,
  pageSize = DEFAULT_PAGE_LIMIT,
) => {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const firstItemIndex = (currentPage - 1) * pageSize

  return {
    currentPage,
    items: items.slice(firstItemIndex, firstItemIndex + pageSize),
    totalPages,
  }
}

export const FeedbackList = ({
  onPageChange,
  page,
  query,
}: {
  onPageChange: (page: number) => void
  page: number
  query: UseQueryResult<FeedbackRecord[]>
}) => {
  const { t, i18n } = useTranslation('feedback')
  const items = query.data ?? []
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_LIMIT)
  const { currentPage, items: pageItems, totalPages } = getFeedbackPage(items, page, pageSize)
  const statusLabel = (status: string): string => {
    const key = feedbackStatusKey(status)
    return key ? t(key) : status
  }

  useEffect(() => {
    if (currentPage !== page) onPageChange(currentPage)
  }, [currentPage, onPageChange, page])

  return (
    <Card variant="section">
      <SectionLabel>{t('list.heading')}</SectionLabel>

      <div className="mt-3">
        <QueryState
          emptyLabel={t('list.empty')}
          errorLabel={t('list.error')}
          isEmpty={items.length === 0}
          loadingLabel={t('list.loading')}
          query={query}
        >
          {() => (
            <>
              <RowList label={t('list.heading')}>
                {pageItems.map((item) => (
                  <Row
                    key={item.id}
                    title={item.title}
                    trailing={
                      <Pill radius="chip" size="sm" tone={feedbackStatusTone(item.status)}>
                        {statusLabel(item.status)}
                      </Pill>
                    }
                  >
                    <span className="mt-1 block whitespace-pre-wrap text-sm text-[color:var(--tx2)]">
                      {item.body}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[color:var(--tx3)]">
                      <span>{formatDate(item.createdAt, i18n.resolvedLanguage ?? i18n.language)}</span>
                      {item.attachmentFilename && <span>📎 {item.attachmentFilename}</span>}
                      {item.githubIssueUrl && (
                        <a
                          className="text-[color:var(--lnk)] hover:underline"
                          href={item.githubIssueUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {t('list.viewIssue', {
                            number: item.githubIssueNumber ? ` #${item.githubIssueNumber}` : '',
                          })}
                        </a>
                      )}
                    </span>
                  </Row>
                ))}
              </RowList>

              <PaginationFooter
                canNext={currentPage < totalPages}
                canPrevious={currentPage > 1}
                className="mt-4"
                hideWhenSinglePage
                label={buildPageLabel(
                  { total: items.length },
                  (currentPage - 1) * pageSize,
                  pageItems.length,
                )}
                onPageChange={(nextPage) => onPageChange(nextPage + 1)}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize)
                  onPageChange(1)
                }}
                page={currentPage - 1}
                pageCount={totalPages}
                pageSize={pageSize}
              />
            </>
          )}
        </QueryState>
      </div>
    </Card>
  )
}
