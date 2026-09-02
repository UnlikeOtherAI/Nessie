import { faDatabase } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useStorageUsage } from '../../../facades/knowledge/file-hooks'
import { formatBytes } from '../../../lib/upload-xhr'

// Compact organization storage usage indicator for the KB header, so users see
// capacity (and proximity to a quota) before an upload is rejected.
export const StorageUsageMeter = () => {
  const { data } = useStorageUsage('organization')
  if (!data) return null

  const used = Number(data.usedBytes)
  const limit = data.limitBytes ? Number(data.limitBytes) : null
  const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null
  const near = pct != null && pct >= 90

  return (
    <span
      className="flex items-center gap-2 text-[11px] text-[color:var(--tx3)]"
      title="Organization storage used"
    >
      <FontAwesomeIcon className="h-3 w-3" icon={faDatabase} />
      <span className={near ? 'text-[color:var(--danger-text)]' : undefined}>
        {formatBytes(used)}
        {limit != null ? ` / ${formatBytes(limit)}` : ''}
      </span>
      {pct != null ? (
        <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-[color:var(--overlay)] sm:block">
          <span
            className="block h-full rounded-full"
            style={{ width: `${pct}%`, background: near ? 'var(--danger)' : 'var(--accent)' }}
          />
        </span>
      ) : null}
    </span>
  )
}
