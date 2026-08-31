type UserStatusEmojiProps = {
  statusEmoji: string | null | undefined
  statusLabel: string | null | undefined
}

// A compact active-status marker placed directly after a person's name.
export const UserStatusEmoji = ({ statusEmoji, statusLabel }: UserStatusEmojiProps) => {
  if (!statusEmoji) return null

  return (
    <span className="admin-status-badge flex-shrink-0">
      <span className="admin-status-badge-icon" title={statusLabel ?? undefined}>
        {statusEmoji}
      </span>
      {statusLabel ? (
        <span className="admin-tooltip" role="tooltip">
          {statusLabel}
        </span>
      ) : null}
    </span>
  )
}
