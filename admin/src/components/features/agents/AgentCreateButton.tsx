type AgentCreateButtonProps = {
  className?: string
  label: string
  onClick: () => void
}

export const AgentCreateButton = ({
  className,
  label,
  onClick,
}: AgentCreateButtonProps) => (
  <button
    className={[
      'admin-button admin-button-primary gap-1.5 whitespace-nowrap',
      className ?? '',
    ].join(' ')}
    onClick={onClick}
    title={label}
    type="button"
  >
    <svg
      className="h-4 w-4 flex-shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        d="M12 5v14M5 12h14"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
    <span>{label}</span>
  </button>
)
